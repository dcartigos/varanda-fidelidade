// POST /api/enviar
//
// Único caminho pelo qual o sistema do Varanda manda mensagem no WhatsApp.
// O navegador NUNCA fala com a YCloud direto: navegador -> este endpoint -> YCloud -> Meta.
// A chave da API existe só aqui, como variável de ambiente do Vercel.
//
// Corpo esperado (JSON):
//   { "telefone": "999691829" | "44999691829" | "+5544999691829",
//     "texto": "mensagem livre",                  <- só funciona na janela de 24h
//     "chave": "5544999691829|2026-08-14|pontos", <- idempotência (recomendado)
//     "forcar": false }                            <- ignora a trava de horário
//
//   ou, para template aprovado (fora da janela de 24h):
//   { "telefone": "...", "template": "saldo_pontos", "idioma": "pt_BR",
//     "parametros": ["José", "126"], "chave": "..." }
//
// Cabeçalho obrigatório: x-varanda-token: <APP_TOKEN>

const { normalizarTelefone } = require('./_lib/telefone');
const { inserir, chaveJaUsada, supabaseConfigurado } = require('./_lib/supabase');

const YCLOUD_BASE = 'https://api.ycloud.com/v2';

function responder(res, status, corpo) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).send(JSON.stringify(corpo));
}

/**
 * Trava de horário do Varanda:
 * - nunca no domingo
 * - nunca depois das 18h
 * - avisa (sem bloquear) fora da faixa 11h-15h
 * Fuso America/Sao_Paulo, independente de onde o servidor rode.
 */
function checarHorario() {
    const agora = new Date(
          new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
        );
    const diaSemana = agora.getDay(); // 0 = domingo
  const hora = agora.getHours();

  if (diaSemana === 0) {
        return { permitido: false, motivo: 'domingo — o Varanda não dispara neste dia' };
  }
    if (hora >= 18) {
          return { permitido: false, motivo: 'depois das 18h — fora da janela permitida' };
    }
    // Faixa recomendada 11h-17h: a rotina do Varanda roda às 15h, no PC do
  // restaurante. Se o aviso disparasse todo dia, viraria ruído e ninguém leria.
  if (hora < 11 || hora >= 17) {
        return {
                permitido: true,
                alerta: 'fora da faixa recomendada de 11h às 17h (hora atual: ' + hora + 'h)',
        };
  }
    return { permitido: true };
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
          return responder(res, 405, { erro: 'Use POST.' });
    }

    // ---- Autenticação do nosso próprio painel -------------------------------
    const tokenEsperado = process.env.APP_TOKEN;
    const tokenRecebido = req.headers['x-varanda-token'];

    if (!tokenEsperado) {
          return responder(res, 500, {
                  erro: 'APP_TOKEN não configurado no servidor.',
          });
    }
    if (tokenRecebido !== tokenEsperado) {
          return responder(res, 401, { erro: 'Token inválido.' });
    }

    const chaveYCloud = process.env.YCLOUD_API_KEY;
    const numeroOrigem = process.env.NUMERO_ORIGEM || '+554420900707';

    if (!chaveYCloud) {
          return responder(res, 500, {
                  erro: 'YCLOUD_API_KEY não configurada no servidor.',
          });
    }

    // ---- Leitura do corpo ---------------------------------------------------
    let corpo = req.body;
    if (typeof corpo === 'string') {
          try {
                  corpo = JSON.parse(corpo);
          } catch (_) {
                  return responder(res, 400, { erro: 'Corpo não é JSON válido.' });
          }
    }
    corpo = corpo || {};

    const { telefone, texto, template, idioma, parametros, chave, forcar } = corpo;

    if (!telefone) {
          return responder(res, 400, { erro: 'Campo "telefone" é obrigatório.' });
    }
    if (!texto && !template) {
          return responder(res, 400, {
                  erro: 'Informe "texto" (mensagem livre, só na janela de 24h) ou "template".',
          });
    }

    // ---- Trava de horário ---------------------------------------------------
    const horario = checarHorario();
    if (!horario.permitido && !forcar) {
          return responder(res, 423, {
                  erro: 'Envio bloqueado pela trava de horário.',
                  motivo: horario.motivo,
                  dica: 'Para testes, mande "forcar": true.',
          });
    }

    // ---- Telefone -----------------------------------------------------------
    const tel = normalizarTelefone(telefone);
    if (!tel.ok) {
          return responder(res, 400, {
                  erro: 'Telefone inválido.',
                  motivo: tel.motivo,
                  recebido: telefone,
          });
    }

    // ---- TRAVA DOS 13 DÍGITOS — adicionada em 20/08/2026 ---------------------
    // Celular brasileiro em E.164 tem exatamente 13 dígitos: 55 + DDD + 9 + 8.
    //
    // POR QUE ISTO EXISTE NO BACKEND E NÃO NA ROTINA:
    // Em 20/08 o relatório de fechamento "saiu" para +554499691829 — 12 dígitos,
    // sem o nono. A Meta ACEITOU, respondeu `sent`, e nunca entregou. Não gerou
    // erro nenhum: nem 131026, nem 131047. Ficou parado num estado que parece
    // sucesso, e ninguém percebeu até o Lucas perguntar por que não recebeu.
    //
    // Uma trava escrita na conversa ou no prompt da tarefa agendada falharia no
    // dia em que alguém reescrevesse o prompt. Aqui, nenhuma rotina consegue
    // furar — e o erro aparece na hora, com o motivo escrito.
    const digitosE164 = tel.e164.replace(/\D/g, '').length;
    if (digitosE164 !== 13) {
          return responder(res, 400, {
                  erro: 'Telefone com quantidade de dígitos inválida.',
                  motivo: 'E.164 precisa ter 13 dígitos (55 + DDD + 9 + 8 dígitos). Este tem ' +
                            digitosE164 + '.',
                  recebido: telefone,
                  normalizado: tel.e164,
                  explicacao: 'A Meta aceita número malformado, responde "sent" e nunca entrega. ' +
                            'Recusar aqui é a única forma de perceber o problema.',
          });
    }

    // ---- Idempotência -------------------------------------------------------
    // Sem isso, uma execução repetida da rotina manda a mesma mensagem duas vezes
    // para o mesmo cliente. Foi a falha #5 apontada pela auditoria.
    if (chave) {
          if (!supabaseConfigurado()) {
                  return responder(res, 500, {
                            erro:
                                        'Você passou "chave" (idempotência) mas o Supabase não está configurado. ' +
                                        'Sem banco não há como garantir que a mensagem não vai duplicar.',
                  });
          }
          const jaFoi = await chaveJaUsada(chave);
          if (jaFoi) {
                  return responder(res, 200, {
                            ignorado: true,
                            motivo: 'Esta mensagem já foi enviada antes (chave de idempotência repetida).',
                            chave,
                  });
          }
    }

    // ---- Montagem da requisição para a YCloud -------------------------------
    let url;
    let payload;

    if (texto) {
          // Mensagem livre. Só é aceita dentro da janela de 24h aberta pelo cliente.
      // Fora da janela a Meta devolve o erro 131047. É cobrada como "service": grátis.
      url = YCLOUD_BASE + '/whatsapp/messages/sendDirectly';
          payload = {
                  from: numeroOrigem,
                  to: tel.e164,
                  type: 'text',
                  text: { body: String(texto) },
          };
    } else {
          // Template aprovado. É o caminho para mensagem que NÓS iniciamos.
      // Categoria importa muito no custo: utility ~US$ 0,0068 · marketing ~US$ 0,0625.
      url = YCLOUD_BASE + '/whatsapp/messages';
          payload = {
                  from: numeroOrigem,
                  to: tel.e164,
                  type: 'template',
                  template: {
                            name: String(template),
                            language: { code: idioma || 'pt_BR' },
                  },
          };

      if (Array.isArray(parametros) && parametros.length > 0) {
              payload.template.components = [
                {
                            type: 'body',
                            parameters: parametros.map((p) => ({ type: 'text', text: String(p) })),
                },
                      ];
      }
    }

    if (chave) {
          // externalId permite reconciliar o evento do webhook com o nosso registro.
      payload.externalId = String(chave).slice(0, 128);
    }

    // ---- Chamada ------------------------------------------------------------
    let respostaYCloud;
    let dados;

    try {
          respostaYCloud = await fetch(url, {
                  method: 'POST',
                  headers: {
                            'X-API-Key': chaveYCloud,
                            'Content-Type': 'application/json',
                            accept: 'application/json',
                  },
                  body: JSON.stringify(payload),
          });
          const bruto = await respostaYCloud.text();
          dados = bruto ? JSON.parse(bruto) : null;
    } catch (e) {
          return responder(res, 502, {
                  erro: 'Falha ao falar com a YCloud.',
                  detalhe: String(e && e.message ? e.message : e),
          });
    }

    const deuCerto = respostaYCloud.ok;

    // ---- Registro no banco --------------------------------------------------
    // Grava SEMPRE, inclusive falha. E grava a chave de idempotência só quando
    // a YCloud aceitou — se falhou na largada, a rotina pode tentar de novo.
    if (supabaseConfigurado()) {
          await inserir('envios', {
                  telefone_e164: tel.e164,
                  tipo: texto ? 'texto_livre' : 'template',
                  template: template || null,
                  conteudo: texto || null,
                  chave_idempotencia: chave || null,
                  ycloud_id: dados && dados.id ? dados.id : null,
                  wamid: dados && dados.wamid ? dados.wamid : null,
                  // ATENÇÃO: 'accepted' NÃO é entrega. O status real chega pelo webhook.
                  status_inicial: dados && dados.status ? dados.status : deuCerto ? 'accepted' : 'erro',
                  http_status: respostaYCloud.status,
                  resposta: dados,
          });

      if (deuCerto && chave) {
              await inserir(
                        'envios_idempotencia',
                { chave, ycloud_id: dados && dados.id ? dados.id : null },
                { ignorarDuplicados: true }
                      );
      }
    }

    if (!deuCerto) {
          return responder(res, respostaYCloud.status, {
                  erro: 'A YCloud/Meta recusou o envio.',
                  resposta: dados,
                  telefone: tel.e164,
          });
    }

    return responder(res, 200, {
          // Deliberadamente NÃO dizemos "entregue". Dizemos "aceito".
                         aceito: true,
          aviso:
                  'Aceito na fila da Meta. Isto NÃO é confirmação de entrega — ' +
                  'o status real chega pelo webhook (delivered / read / failed).',
          ycloud_id: dados.id,
          wamid: dados.wamid,
          status: dados.status,
          para: tel.e164,
          alerta_horario: horario.alerta || null,
          alerta_telefone: tel.alerta || null,
    });
};
