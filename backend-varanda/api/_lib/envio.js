// api/_lib/envio.js
//
// Lógica central de envio de mensagem no WhatsApp (via YCloud). Esta função
// NÃO faz nenhuma verificação de autenticação — autenticação é assunto de
// quem chama de fora (api/enviar.js valida o x-varanda-token antes de
// chamar enviarMensagem()).
//
// Por que isto existe como módulo separado, e não dentro de api/enviar.js:
// até 22/08/2026 api/rotina-diaria.js e api/backfill-pontos.js chamavam o
// próprio /api/enviar por HTTP (fetch interno), mandando o APP_TOKEN no
// cabeçalho. Isso criou uma dependência de rede + token onde não havia
// necessidade nenhuma — e quando o token não bateu nessa chamada interna
// (rotina rodando na URL de deployment, não no domínio de produção), o
// envio de pontos de 21/08 falhou silenciosamente (recusados: 15, "Token
// inválido"), só percebido porque o teste seco=1 não passa por aqui.
//
// A partir de agora: api/enviar.js, api/rotina-diaria.js e
// api/backfill-pontos.js chamam TODOS a mesma função, em memória, sem HTTP
// e sem token entre si. Só existe UMA cópia desta lógica — se um dia ela
// mudar, muda para os três de uma vez.

const { normalizarTelefone } = require('./telefone');
const { inserir, chaveJaUsada, supabaseConfigurado } = require('./supabase');

const YCLOUD_BASE = 'https://api.ycloud.com/v2';

/**
 * Trava de horário do Varanda:
 * - nunca no domingo
 * - nunca depois das 18h
 * - avisa (sem bloquear) fora da faixa 11h-17h
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
  if (hora < 11 || hora >= 17) {
    return {
      permitido: true,
      alerta: 'fora da faixa recomendada de 11h às 17h (hora atual: ' + hora + 'h)',
    };
  }
  return { permitido: true };
}

/**
 * Envia uma mensagem no WhatsApp via YCloud e grava o resultado em `envios`.
 *
 * payload: { telefone, texto?, template?, idioma?, parametros?, chave?, forcar? }
 *
 * Retorna sempre um objeto com `httpStatus` (o status HTTP que quem chamou
 * por HTTP — api/enviar.js — deve devolver ao navegador) e os mesmos campos
 * que api/enviar.js sempre devolveu (erro, aceito, motivo, ycloud_id, ...),
 * para que rotina-diaria.js e backfill-pontos.js continuem lendo `.aceito`
 * e `.erro` exatamente como liam antes.
 */
async function enviarMensagem(payload) {
  const chaveYCloud = process.env.YCLOUD_API_KEY;
  const numeroOrigem = process.env.NUMERO_ORIGEM || '+554420900707';

  if (!chaveYCloud) {
    return { httpStatus: 500, erro: 'YCLOUD_API_KEY não configurada no servidor.' };
  }

  const { telefone, texto, template, idioma, parametros, chave, forcar } = payload || {};

  if (!telefone) {
    return { httpStatus: 400, erro: 'Campo "telefone" é obrigatório.' };
  }
  if (!texto && !template) {
    return {
      httpStatus: 400,
      erro: 'Informe "texto" (mensagem livre, só na janela de 24h) ou "template".',
    };
  }

  // ---- Trava de horário ---------------------------------------------------
  const horario = checarHorario();
  if (!horario.permitido && !forcar) {
    return {
      httpStatus: 423,
      erro: 'Envio bloqueado pela trava de horário.',
      motivo: horario.motivo,
      dica: 'Para testes, mande "forcar": true.',
    };
  }

  // ---- Telefone -------------------------------------------------------------
  const tel = normalizarTelefone(telefone);
  if (!tel.ok) {
    return {
      httpStatus: 400,
      erro: 'Telefone inválido.',
      motivo: tel.motivo,
      recebido: telefone,
    };
  }

  // ---- TRAVA DOS 13 DÍGITOS — adicionada em 20/08/2026 -----------------------
  // Celular brasileiro em E.164 tem exatamente 13 dígitos: 55 + DDD + 9 + 8.
  // Em 20/08 o relatório de fechamento "saiu" para +554499691829 — 12 dígitos,
  // sem o nono. A Meta ACEITOU, respondeu `sent`, e nunca entregou. Recusar
  // aqui é a única forma de perceber o problema na hora.
  const digitosE164 = tel.e164.replace(/\D/g, '').length;
  if (digitosE164 !== 13) {
    return {
      httpStatus: 400,
      erro: 'Telefone com quantidade de dígitos inválida.',
      motivo: 'E.164 precisa ter 13 dígitos (55 + DDD + 9 + 8 dígitos). Este tem ' +
        digitosE164 + '.',
      recebido: telefone,
      normalizado: tel.e164,
      explicacao: 'A Meta aceita número malformado, responde "sent" e nunca entrega. ' +
        'Recusar aqui é a única forma de perceber o problema.',
    };
  }

  // ---- Idempotência -----------------------------------------------------------
  if (chave) {
    if (!supabaseConfigurado()) {
      return {
        httpStatus: 500,
        erro: 'Você passou "chave" (idempotência) mas o Supabase não está configurado. ' +
          'Sem banco não há como garantir que a mensagem não vai duplicar.',
      };
    }
    const jaFoi = await chaveJaUsada(chave);
    if (jaFoi) {
      return {
        httpStatus: 200,
        ignorado: true,
        motivo: 'Esta mensagem já foi enviada antes (chave de idempotência repetida).',
        chave,
      };
    }
  }

  // ---- Montagem da requisição para a YCloud ------------------------------------
  let url;
  let corpoYCloud;

  if (texto) {
    url = YCLOUD_BASE + '/whatsapp/messages/sendDirectly';
    corpoYCloud = {
      from: numeroOrigem,
      to: tel.e164,
      type: 'text',
      text: { body: String(texto) },
    };
  } else {
    url = YCLOUD_BASE + '/whatsapp/messages';
    corpoYCloud = {
      from: numeroOrigem,
      to: tel.e164,
      type: 'template',
      template: {
        name: String(template),
        language: { code: idioma || 'pt_BR' },
      },
    };
    if (Array.isArray(parametros) && parametros.length > 0) {
      corpoYCloud.template.components = [
        {
          type: 'body',
          parameters: parametros.map((p) => ({ type: 'text', text: String(p) })),
        },
      ];
    }
  }

  if (chave) {
    corpoYCloud.externalId = String(chave).slice(0, 128);
  }

  // ---- Chamada --------------------------------------------------------------
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
      body: JSON.stringify(corpoYCloud),
    });
    const bruto = await respostaYCloud.text();
    dados = bruto ? JSON.parse(bruto) : null;
  } catch (e) {
    return {
      httpStatus: 502,
      erro: 'Falha ao falar com a YCloud.',
      detalhe: String(e && e.message ? e.message : e),
    };
  }

  const deuCerto = respostaYCloud.ok;

  // ---- Registro no banco ------------------------------------------------------
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
    return {
      httpStatus: respostaYCloud.status,
      erro: 'A YCloud/Meta recusou o envio.',
      resposta: dados,
      telefone: tel.e164,
    };
  }

  return {
    httpStatus: 200,
    // Deliberadamente NÃO dizemos "entregue". Dizemos "aceito".
    aceito: true,
    aviso: 'Aceito na fila da Meta. Isto NÃO é confirmação de entrega — ' +
      'o status real chega pelo webhook (delivered / read / failed).',
    ycloud_id: dados.id,
    wamid: dados.wamid,
    status: dados.status,
    para: tel.e164,
    alerta_horario: horario.alerta || null,
    alerta_telefone: tel.alerta || null,
  };
}

module.exports = { enviarMensagem };
