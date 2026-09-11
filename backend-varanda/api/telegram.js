// GET /api/telegram
//
// O CANAL INTERNO DE RELATORIOS (11/09/2026).
//
// POR QUE ESTE ARQUIVO EXISTE
// O relatorio de fechamento ia por WhatsApp e falhava quase todo dia para o
// Leopoldo com erro 131047 - a "janela de 24 horas" da Meta: texto livre so e
// entregue a quem conversou com o numero nas ultimas 24h. Essa regra protege
// CONSUMIDOR de spam; o Leopoldo e socio, mas a Meta nao sabe disso e a regra
// nao tem excecao.
//
// Ideia do Lucas (11/09): relatorio interno vai por TELEGRAM. Sem janela de
// 24h, sem template, sem aprovacao, sem custo por mensagem.
//
// DIVISAO DE CANAIS:
//   WhatsApp -> CLIENTE  (pontos, campanhas)
//   Telegram -> EQUIPE   (relatorio diario, alertas do vigia)
//
// COMO USAR - sempre com ?token=... (o TESTE_TOKEN)
//   ?acao=status      -> diz se token e chat_id estao configurados
//   ?acao=descobrir   -> mostra os chats que o bot ja viu (id e nome)
//   ?acao=teste       -> manda mensagem de teste
//   ?acao=enviar&texto=... -> manda um texto qualquer
//
// SEGURANCA: o TELEGRAM_BOT_TOKEN vive so como variavel de ambiente no
// Vercel. Este endpoint NUNCA devolve o valor - no maximo o TAMANHO.

const TETO_TEXTO = 4000;

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
}

async function enviarTelegram(texto, chatIdOpcional) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(chatIdOpcional || process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token) return { ok: false, erro: 'TELEGRAM_BOT_TOKEN nao configurado no Vercel.' };
  if (!chatId) return { ok: false, erro: 'TELEGRAM_CHAT_ID nao configurado no Vercel.' };
  const corpo = String(texto || '').slice(0, TETO_TEXTO);
  if (!corpo) return { ok: false, erro: 'Texto vazio.' };
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: corpo,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.ok, status: r.status, erro: j.ok ? null : (j.description || 'erro desconhecido') };
  } catch (e) {
    return { ok: false, erro: 'falha de rede: ' + e.message };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return responder(res, 405, { erro: 'Use GET.' });

  const recebido = String((req.query && req.query.token) || req.headers['x-varanda-token'] || '').trim();
  const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean).map((t) => String(t).trim());
  if (!recebido || !aceitos.includes(recebido)) {
    return responder(res, 401, { erro: 'Token invalido.' });
  }

  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const acao = String((req.query && req.query.acao) || 'status').trim();

  if (acao === 'status') {
    return responder(res, 200, {
      token_configurado: !!token,
      token_tamanho: token.length || 0,
      chat_id_configurado: !!String(process.env.TELEGRAM_CHAT_ID || '').trim(),
      acoes: ['status', 'descobrir', 'teste', 'enviar'],
    });
  }

  if (!token) {
    return responder(res, 500, {
      erro: 'TELEGRAM_BOT_TOKEN nao configurado.',
      o_que_fazer: 'Vercel > Settings > Environment Variables > TELEGRAM_BOT_TOKEN (Secret).',
    });
  }

  if (acao === 'descobrir') {
    const r = await fetch('https://api.telegram.org/bot' + token + '/getUpdates?limit=100');
    const j = await r.json().catch(() => ({}));
    if (!j.ok) {
      return responder(res, 502, { erro: 'getUpdates falhou.', detalhe: j.description || null });
    }
    const vistos = {};
    for (const u of (j.result || [])) {
      const m = u.message || u.my_chat_member || u.channel_post || {};
      const c = m.chat;
      if (c && c.id) {
        vistos[c.id] = {
          chat_id: String(c.id),
          tipo: c.type,
          nome: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
        };
      }
    }
    const lista = Object.values(vistos);
    return responder(res, 200, {
      chats_encontrados: lista.length,
      chats: lista,
      o_que_fazer: lista.length
        ? 'Guarde o chat_id na variavel TELEGRAM_CHAT_ID do Vercel.'
        : 'Nenhum chat visto. Abra conversa com o bot (ou adicione ao grupo) e mande /start.',
    });
  }

  if (acao === 'teste') {
    const chatId = String((req.query && req.query.chat_id) || '').trim() || undefined;
    const agora = new Date(Date.now() - 3 * 3600 * 1000)
      .toISOString().slice(0, 16).replace('T', ' ');
    const r = await enviarTelegram(
      '*VARANDA - teste do canal de relatorios*' + '\n\n' +
      'Se voce esta lendo isto, o relatorio diario passa a chegar aqui, ' +
      'todos os dias as 15h, sem depender de ninguem responder nada.' + '\n\n' +
      '_' + agora + '_',
      chatId
    );
    return responder(res, r.ok ? 200 : 502, r);
  }

  if (acao === 'enviar') {
    const texto = String((req.query && req.query.texto) || '').trim();
    if (!texto) return responder(res, 400, { erro: 'Falta o parametro texto.' });
    const r = await enviarTelegram(texto, String((req.query && req.query.chat_id) || '').trim() || undefined);
    return responder(res, r.ok ? 200 : 502, r);
  }

  return responder(res, 400, { erro: 'Acao desconhecida: ' + acao });
};

module.exports.enviarTelegram = enviarTelegram;
