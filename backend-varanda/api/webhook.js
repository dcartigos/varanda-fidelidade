// POST /api/webhook?t=<WEBHOOK_TOKEN>
//
// Recebe os eventos da YCloud. É a peça que impede o sistema de mentir:
// sem ela, o painel mostraria como "enviada" uma mensagem que a Meta recusou.
// Foi exatamente esse engano que aconteceu no teste de 14/08/2026.
//
// Eventos que interessam ao Varanda:
//   whatsappMessage.updated        -> status: accepted, sent, delivered, read, failed
//   whatsappInboundMessage.received -> cliente mandou mensagem (abre a janela de 24h)
//   whatsapp.smb.message.echoes    -> mensagem digitada pela equipe no app (Coexistence)
//   whatsappPhoneNumber.updated    -> mudança no número (inclui cair para Offline)
//
// Regra de ouro: responder 200 rápido, SEMPRE. Se devolvermos erro, a YCloud
// reenvia o evento e a fila engasga.

const { inserir, supabaseConfigurado } = require('./_lib/supabase');

// Palavras que o cliente pode mandar para sair das promoções.
const PALAVRAS_SAIR = ['sair', 'parar', 'cancelar', 'descadastrar', 'stop', 'remover'];

function ehPedidoDeSaida(texto) {
  if (!texto) return false;
  const limpo = String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .trim();
  // Aceita a palavra sozinha ou em frase curta ("quero sair", "sair!")
  return PALAVRAS_SAIR.some((p) => limpo === p || limpo.split(/\s+/).includes(p));
}

module.exports = async function handler(req, res) {
  // Verificação de URL que alguns provedores fazem antes de ativar o webhook.
  if (req.method === 'GET') {
    res.status(200).send('ok');
    return;
  }

  if (req.method !== 'POST') {
    res.status(200).send('ok');
    return;
  }

  // ---- Segredo na URL -----------------------------------------------------
  // Sem isso qualquer um poderia inventar eventos e sujar nosso banco.
  const tokenEsperado = process.env.WEBHOOK_TOKEN;
  const tokenRecebido =
    (req.query && (req.query.t || req.query.token)) || null;

  if (tokenEsperado && tokenRecebido !== tokenEsperado) {
    // Responde 200 mesmo assim para não dar pista a quem estiver sondando,
    // mas não grava nada.
    res.status(200).send('ok');
    return;
  }

  // ---- Corpo --------------------------------------------------------------
  let evento = req.body;
  if (typeof evento === 'string') {
    try {
      evento = JSON.parse(evento);
    } catch (_) {
      evento = { _bruto: evento };
    }
  }
  evento = evento || {};

  const tipo = evento.type || evento.event || 'desconhecido';

  // ---- Registro cru -------------------------------------------------------
  // Guardamos o evento inteiro antes de interpretar. Se amanhã a gente
  // descobrir que precisava de um campo, ele está lá.
  if (supabaseConfigurado()) {
    await inserir('eventos_whatsapp', {
      tipo,
      ycloud_event_id: evento.id || null,
      payload: evento,
    });
  } else {
    console.log('[webhook] Supabase não configurado. Evento recebido:', tipo);
  }

  // ---- Interpretação ------------------------------------------------------
  try {
    const msg = evento.whatsappMessage || null;
    const entrada = evento.whatsappInboundMessage || null;

    // (1) Status de mensagem que NÓS mandamos
    if (msg && supabaseConfigurado()) {
      await inserir('status_mensagens', {
        ycloud_id: msg.id || null,
        wamid: msg.wamid || null,
        chave_idempotencia: msg.externalId || null,
        telefone_e164: msg.to || null,
        status: msg.status || null,
        erro_codigo: msg.errorCode || null,
        erro_mensagem: msg.errorMessage || null,
        preco: typeof msg.totalPrice === 'number' ? msg.totalPrice : null,
        moeda: msg.currency || null,
        categoria_preco: msg.pricingCategory || null,
        enviado_em: msg.sendTime || null,
        entregue_em: msg.deliverTime || null,
        lido_em: msg.readTime || null,
      });
    }

    // (2) Mensagem que o CLIENTE mandou
    if (entrada) {
      const textoCliente =
        (entrada.text && entrada.text.body) ||
        (entrada.button && entrada.button.text) ||
        null;

      if (supabaseConfigurado()) {
        await inserir('mensagens_recebidas', {
          wamid: entrada.wamid || entrada.id || null,
          telefone_e164: entrada.from || null,
          tipo_conteudo: entrada.type || null,
          texto: textoCliente,
          recebido_em: entrada.sendTime || entrada.createTime || null,
          payload: entrada,
        });
      }

      // (3) Opt-out de verdade: SAIR grava bloqueio no banco.
      // Sem isso, o "SAIR" é decorativo e a gente descumpre a LGPD.
      if (ehPedidoDeSaida(textoCliente) && entrada.from) {
        if (supabaseConfigurado()) {
          await inserir(
            'bloqueios_marketing',
            {
              telefone_e164: entrada.from,
              motivo: 'cliente pediu SAIR pelo WhatsApp',
              texto_original: textoCliente,
            },
            { ignorarDuplicados: true }
          );
        }
        console.log('[webhook] OPT-OUT registrado para', entrada.from);
      }
    }
  } catch (e) {
    // Nunca deixamos a interpretação derrubar o webhook. O evento cru já está salvo.
    console.error('[webhook] erro ao interpretar evento:', e);
  }

  res.status(200).send('ok');
};
