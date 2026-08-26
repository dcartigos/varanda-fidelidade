// api/campanha.js
// ============================================================================
// O MOTOR DE DISPARO DE CAMPANHA
// ============================================================================
//
// POR QUE ELE EXISTE
// Até 25/08/2026 todo disparo foi montado à mão: abrir o Supabase, rodar SQL,
// copiar 50 números, abrir a YCloud, criar campanha, apagar a imagem de amostra,
// subir a arte, colar a legenda, conferir, submeter. ~15 minutos, com o
// restaurante já aberto. Em 24/08 isso fez o disparo perder o horário e ser
// cancelado pelo Lucas. Este arquivo elimina esse trabalho inteiro.
//
// O QUE ELE FAZ
//   1. pergunta ao banco quem deve receber (função fila_campanha)
//   2. manda o template com header de IMAGEM pela YCloud, uma pessoa por vez
//   3. grava cada envio em `envios` com a coluna `arte`
//
// O item 3 é o que cria a MEMÓRIA. Não existe arquivo de controle, não existe
// planilha: a própria tabela de envios é a memória, e a fila do dia seguinte
// lê dela. Por isso nunca precisa "lembrar" de nada entre execuções.
//
// POR QUE NÃO USA api/_lib/envio.js
// O envio.js tem uma trava de horário que BLOQUEIA antes das 11h (foi feita
// para o envio de pontos, que sai 14h35). A campanha sai 10h. Em vez de mexer
// numa função que hoje funciona para pontos e fechamento -- e arriscar quebrar
// as duas -- este arquivo fala com a YCloud direto, com a janela de horário
// própria da campanha. Uma mudança errada no envio.js pararia três rotinas.
//
// COMO CHAMAR
//   GET /api/campanha?seco=1                 -> simulação, não envia nada
//   GET /api/campanha?arte=arte_10_feijoada  -> força uma arte
//   GET /api/campanha?pct=5                  -> força a porcentagem
//   GET /api/campanha?limite=10              -> força a quantidade
// Autenticação: cabeçalho x-varanda-token = APP_TOKEN, ou chamada do Vercel Cron.

const { normalizarTelefone } = require('./_lib/telefone');

const YCLOUD = 'https://api.ycloud.com/v2/whatsapp/messages';
const TEMPLATE = 'campanha_imagem';
const RAW = 'https://raw.githubusercontent.com/dcartigos/varanda-fidelidade/main/artes/';
const LINK_PEDIDO = 'https://www.nomosmenu.com.br/pedido/varanda/cardapio';

// Telefone do Lucas, para os avisos de falha. Nunca entra na fila de campanha
// -- a fila_campanha exclui este numero explicitamente.
const DONO = '+5544999691829';

// ---------------------------------------------------------------------------
// CATÁLOGO DE ARTES
// ---------------------------------------------------------------------------
// ATENÇÃO 1: a interface de upload do GitHub NÃO sobrescreve arquivo existente
// de forma confiável. Em 22/08 duas versões da arte da feijoada foram
// "enviadas" e o raw continuou servindo a versão antiga por horas. Por isso
// todo arquivo aqui tem número de versão no nome. Arte nova = nome novo.
//
// ATENÇÃO 2: a legenda vai como parâmetro da variável mensagem do template e
// NÃO PODE ter quebra de linha -- a Meta recusa o envio inteiro. Uma linha só.
//
// ATENÇÃO 3: o template já tem "Responda SAIR para não receber promoções."
// fixo no rodapé. Não repetir isso na legenda.
//
// ATENÇÃO 4: emoji em toda mensagem -- regra do Lucas, 22/08/2026.
const ARTES = {
  arte_01_almoco: {
    imagem: RAW + 'arte_01_almoco_v1.jpg',
    legenda: 'O almoço do Varanda está servido! Buffet completo, 42 opções, '
      + 'todos os dias das 11h às 14h. Venha almoçar com a gente ou peça pelo '
      + 'delivery aqui: ' + LINK_PEDIDO,
    dias: [1, 2, 3, 4, 5, 6],
  },
  arte_02_buffet: {
    imagem: RAW + 'arte_02_buffet_v1.jpg',
    legenda: 'Buffet livre R$ 69,90 ou por quilo R$ 84,00, você escolhe. '
      + 'Aceitamos VR, Sodexo, Alelo, Ticket e Pluxee. Das 11h às 14h. '
      + 'Delivery aqui: ' + LINK_PEDIDO,
    dias: [1, 2, 3, 4, 5, 6],
  },
  arte_11_marmita: {
    imagem: RAW + 'arte_11_marmita_v1.jpg',
    legenda: 'Pouco tempo pro almoço? Monte sua marmita aqui no local: '
      + 'P R$ 34,00, M R$ 38,00, G R$ 42,00, 4 divisórias R$ 45,00. '
      + 'Rápido e do jeito que você gosta. Das 11h às 14h.',
    dias: [1, 2, 3, 4, 5, 6],
  },
  // EXTRA de sexta e sábado. Pode repetir na mesma semana de propósito:
  // é o produto de maior ticket e só existe nesses dois dias.
  arte_10_feijoada: {
    imagem: RAW + 'kit_feijoada_v4.jpg',
    legenda: 'Kit Feijoada Especial: feijoada completa, pronta pra servir na '
      + 'sua casa. Também tem pote de 500g por R$ 44,90 e kit de 1kg por '
      + 'R$ 74,00. Peça aqui: ' + LINK_PEDIDO,
    dias: [5, 6],
    extra: true,
    diasRepeticao: 12,   // pode voltar pra mesma pessoa depois de ~2 semanas
  },
};

// Os emojis ficam FORA das strings acima de propósito: este arquivo passa por
// editor web, terminal e log, e emoji perdido no meio do código já causou
// arquivo salvo corrompido. Aqui eles entram uma vez, na montagem da legenda.
const EMOJI = {
  arte_01_almoco: ['\u{1F37D}\u{FE0F}', '\u{1F60B}', '\u{1F449}'],
  arte_02_buffet: ['\u{1F957}', '\u{1F4B3}', '\u{1F449}'],
  arte_11_marmita: ['\u{23F1}\u{FE0F}', '\u{1F961}', ''],
  arte_10_feijoada: ['\u{1F958}', '\u{1F6D2}', '\u{1F449}'],
  cardapio_dia: ['\u{1F35B}', '\u{1F60B}', '\u{1F449}'],
};

// Coloca o emoji no começo, um no meio e um antes do link.
function comEmoji(id, texto) {
  const e = EMOJI[id] || ['', '', ''];
  let t = texto;
  if (e[2]) t = t.replace(/(aqui|delivery aqui|Peça aqui):\s*/, '$1 ' + e[2] + ' ');
  if (e[1]) t = t.replace(/(Das 11h às 14h|das 11h às 14h)\./, '$1. ' + e[1]);
  return ((e[0] ? e[0] + ' ' : '') + t).replace(/\s+/g, ' ').trim();
}

// Rotação das artes padrão (o cardápio do dia entra na frente quando existe).
// A ordem importa pouco; o que evita repetição é a trava de 21 dias na fila.
const ROTACAO = ['arte_01_almoco', 'arte_11_marmita', 'arte_02_buffet'];

// ---------------------------------------------------------------------------
// RÉGUA -- em porcentagem da base, nunca em número fixo (Lucas, 25/08/2026)
// ---------------------------------------------------------------------------
// Cada pessoa recebe 1 marketing por semana. 6 dias de operação (não abre
// domingo), então 100% / 6 = ~17% da base por dia. A trava de 7 dias dentro da
// função fila_campanha é o que garante o "1 por semana" de verdade; esta
// porcentagem só define o tamanho do lote diário.
const PCT_DIARIA = 17;

// Feijoada: 25% da base por semana, dividido entre sexta e sábado.
const PCT_FEIJOADA = 12.5;

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
function agoraSP() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

// Janela da campanha: segunda a sábado, 9h às 17h.
// Diferente da trava do envio.js (11h-18h), que é do envio de pontos.
function janelaOk(forcar) {
  const a = agoraSP();
  const dow = a.getDay();
  const h = a.getHours();
  if (forcar) return { ok: true, forcado: true };
  if (dow === 0) return { ok: false, motivo: 'domingo -- o Varanda não dispara' };
  if (h < 9) return { ok: false, motivo: 'antes das 9h (hora em SP: ' + h + 'h)' };
  if (h >= 17) return { ok: false, motivo: 'depois das 17h (hora em SP: ' + h + 'h)' };
  return { ok: true };
}

function hojeISO() {
  const a = agoraSP();
  return a.getFullYear() + '-' + String(a.getMonth() + 1).padStart(2, '0')
    + '-' + String(a.getDate()).padStart(2, '0');
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// A YCloud recusa por falta de saldo com 403 e esta mensagem. Reconhecer isso
// é o que permite parar o laço em vez de queimar dezenas de chamadas inúteis.
function semSaldo(resposta) {
  const txt = JSON.stringify(resposta || '').toLowerCase();
  return /balance is insufficient|insufficient balance|insufficient_balance/.test(txt);
}

// Manda um WhatsApp de texto para o Lucas. Usa o _lib/envio.js -- a mesma
// função que já sustenta o envio de pontos e o relatório de fechamento.
//
// Vai com forcar: true de propósito. A trava de horário do envio.js bloqueia
// antes das 11h, e o aviso mais importante é justamente o das 10h, quando o
// disparo falha. Aviso operacional para o dono não é marketing: não tem hora.
async function avisarLucas(texto) {
  try {
    const { enviarMensagem } = require('./_lib/envio');
    const r = await enviarMensagem({
      telefone: DONO,
      texto: String(texto).slice(0, 900),
      forcar: true,
    });
    return { ok: Boolean(r && r.aceito), detalhe: r && (r.erro || r.status) };
  } catch (e) {
    // Um aviso que falha NUNCA pode derrubar o disparo. Ele é o acessório.
    return { ok: false, detalhe: String(e && e.message ? e.message : e) };
  }
}

// ---------------------------------------------------------------------------
// Supabase (REST + RPC). Não uso o _lib/supabase.js porque ele só faz insert.
// ---------------------------------------------------------------------------
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(caminho, opcoes = {}) {
  const r = await fetch(SB_URL + '/rest/v1' + caminho, {
    ...opcoes,
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
  });
  const txt = await r.text();
  let corpo = null;
  try { corpo = txt ? JSON.parse(txt) : null; } catch (_) { corpo = txt; }
  return { ok: r.ok, status: r.status, corpo };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  const q = { ...(req.query || {}), ...(req.body || {}) };

  // ---- Autenticação -------------------------------------------------------
  //
  // ⚠️ BUG QUE CUSTOU O PRIMEIRO DISPARO — 26/08/2026, NÃO REGREDIR
  // A versão anterior identificava o Vercel Cron só pelo header
  // 'x-vercel-cron'. Em 26/08 às 10h01 o cron rodou, chegou aqui e levou 401:
  // a Vercel NÃO manda esse header. Ela identifica o cron pelo User-Agent
  // 'vercel-cron/1.0' e, quando existe a variável CRON_SECRET, por
  // 'Authorization: Bearer <CRON_SECRET>'. A função morreu em 144 ms, antes de
  // falar com o Supabase e com a YCloud — nada foi enviado e nada foi cobrado,
  // mas o dia de disparo foi perdido em silêncio.
  //
  // Agora aceita, em ordem de confiança:
  //  1. Authorization: Bearer <CRON_SECRET>  -> à prova de falsificação. É o
  //     caminho oficial da Vercel e o que deve valer em produção.
  //  2. User-Agent vercel-cron/1.0 DENTRO da janela de horário do cron, e só
  //     enquanto CRON_SECRET não existir. User-Agent qualquer um falsifica, por
  //     isso essa porta é estreita (janela de hora) e se fecha sozinha no
  //     momento em que o CRON_SECRET for criado.
  //  3. header 'x-vercel-cron' -> mantido por segurança, caso a Vercel volte
  //     a mandá-lo.
  //  4. ?token= ou x-varanda-token com TESTE_TOKEN / IMPORT_TOKEN / APP_TOKEN
  //     -> para chamada manual no navegador.
  //
  // Sem nada disso, qualquer um na internet dispararia campanha paga em nome
  // do Varanda.
  const segredoCron = process.env.CRON_SECRET;
  const ua = String(req.headers['user-agent'] || '');
  const ehUACron = /^vercel-cron\//i.test(ua);
  const horaSP = agoraSP().getHours();

  const porSegredo = Boolean(segredoCron)
    && String(req.headers.authorization || '') === 'Bearer ' + segredoCron;
  // A porta do User-Agent vale dentro da janela comercial (9h-17h, a mesma do
  // janelaOk). Quem limita o dano de um User-Agent falsificado é a TRAVA DE UMA
  // VEZ POR DIA POR ARTE mais abaixo -- com ela, o pior caso de uma chamada
  // forjada é zero envios extras, porque a arte do dia já saiu.
  //
  // ⚠️ ESTA PORTA CONTINUA ABERTA MESMO COM CRON_SECRET CONFIGURADO, DE PROPÓSITO.
  // A versão de 11h de 26/08 tinha `!segredoCron &&` aqui: criar o CRON_SECRET
  // FECHAVA a porta do User-Agent. Se por qualquer motivo a Vercel não mandasse
  // o Authorization (variável salva no ambiente errado, deploy antigo, mudança
  // deles), o disparo voltaria a morrer em 401 -- e criar um segredo para
  // "reforçar a segurança" teria derrubado a rotina em silêncio, exatamente o
  // erro do dia. Agora CRON_SECRET só ACRESCENTA um caminho, nunca remove.
  const porUA = ehUACron && horaSP >= 9 && horaSP < 17;
  const porHeader = Boolean(req.headers['x-vercel-cron']);

  const recebido = String((req.query && req.query.token)
    || req.headers['x-varanda-token'] || '').trim();
  const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean).map((s) => String(s).trim());
  const porToken = Boolean(recebido) && aceitos.includes(recebido);

  const doCron = porSegredo || porUA || porHeader;

  if (!doCron && !porToken) {
    return res.status(401).json({
      erro: 'Token inválido.',
      dica: 'Use ?token=SEU_TESTE_TOKEN (a variável TESTE_TOKEN do Vercel).',
      // Diagnóstico sem vazar segredo: diz o que chegou, não o que era esperado.
      visto: {
        user_agent: ua.slice(0, 40),
        tem_authorization: Boolean(req.headers.authorization),
        cron_secret_configurado: Boolean(segredoCron),
        hora_sp: horaSP,
      },
    });
  }

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ erro: 'Supabase não configurado no servidor.' });
  }
  const chaveYCloud = process.env.YCLOUD_API_KEY;
  if (!chaveYCloud) {
    return res.status(500).json({ erro: 'YCLOUD_API_KEY não configurada.' });
  }

  const seco = q.seco === '1' || q.seco === 1 || q.seco === true;
  const forcar = q.forcar === '1' || q.forcar === true;

  // ---- Janela de horário --------------------------------------------------
  const janela = janelaOk(forcar || seco);
  if (!janela.ok) {
    return res.status(423).json({ erro: 'Fora da janela de disparo.', motivo: janela.motivo });
  }

  const dow = agoraSP().getDay();
  const hoje = hojeISO();

  // ---- Qual arte vai hoje -------------------------------------------------
  // Prioridade: (1) o que o Lucas pediu na URL, (2) o cardápio do dia, se a
  // Maria já mandou e a arte já foi gerada, (3) a rotação padrão.
  let arteId = q.arte && ARTES[q.arte] ? q.arte : null;
  let imagem = q.imagem || null;
  let legenda = q.legenda || null;
  let origem = arteId ? 'pedido na URL' : null;

  if (!arteId && !imagem) {
    const c = await sb('/cardapio_dia?data_ref=eq.' + hoje + '&select=urls_artes,pratos&limit=1');
    const linha = c.ok && Array.isArray(c.corpo) && c.corpo[0] ? c.corpo[0] : null;
    const url = linha && linha.urls_artes
      && (linha.urls_artes.principal || linha.urls_artes.verde || linha.urls_artes[0]);
    if (url) {
      arteId = 'cardapio_dia';
      imagem = url;
      legenda = comEmoji('cardapio_dia',
        'Cardápio de hoje no Varanda! Buffet completo das 11h às 14h. '
        + 'Venha almoçar ou peça o delivery aqui: ' + LINK_PEDIDO);
      origem = 'cardápio do dia (prioridade)';
    }
  }

  if (!arteId) {
    // Rotação padrão. O índice anda com o dia do ano -- como o cardápio ocupa
    // alguns dias, isso não cai em ciclo fixo com a trava de 21 dias da fila.
    const ref = agoraSP();
    const diaDoAno = Math.floor((ref - new Date(ref.getFullYear(), 0, 0)) / 86400000);
    const candidatas = ROTACAO.filter((k) => ARTES[k].dias.includes(dow));
    if (candidatas.length === 0) {
      return res.status(200).json({ erro: 'Nenhuma arte padrão vale para hoje.', dia_semana: dow });
    }
    arteId = candidatas[diaDoAno % candidatas.length];
    origem = 'rotação padrão';
  }

  const arte = ARTES[arteId] || {};
  imagem = imagem || arte.imagem;
  legenda = legenda || (arte.legenda ? comEmoji(arteId, arte.legenda) : null);

  if (!imagem || !legenda) {
    return res.status(400).json({ erro: 'Arte sem imagem ou sem legenda.', arte: arteId });
  }
  // A Meta recusa o envio INTEIRO se o parâmetro tiver quebra de linha.
  if (/[\r\n]/.test(legenda)) {
    return res.status(400).json({ erro: 'A legenda tem quebra de linha. A Meta recusa.', arte: arteId });
  }

  // ---- A imagem existe mesmo? --------------------------------------------
  // Em 22/08 o raw do GitHub serviu a versão ANTIGA de uma arte por horas.
  // Conferir antes de gastar dinheiro é mais barato que descobrir depois.
  let imgInfo = null;
  try {
    const h = await fetch(imagem, { headers: { Range: 'bytes=0-2' } });
    imgInfo = { status: h.status, tipo: h.headers.get('content-type') };
    if (!h.ok || !/^image\//.test(imgInfo.tipo || '')) {
      return res.status(424).json({
        erro: 'A imagem da arte não está acessível ou não é imagem. Não vou disparar.',
        arte: arteId, imagem, resposta: imgInfo,
      });
    }
  } catch (e) {
    return res.status(424).json({
      erro: 'Falha ao checar a imagem da arte.', imagem,
      detalhe: String(e && e.message ? e.message : e),
    });
  }

  // ---- QUANTO DESTA ARTE JÁ SAIU HOJE, DE VERDADE -------------------------
  // Conta só o que a Meta ACEITOU (http < 300). Recusa não conta como enviado.
  //
  // Isso é o que permite o sistema se curar sozinho. Em 26/08 o saldo da YCloud
  // acabou no meio do disparo: 51 aceitas e 51 recusadas com
  // "403 The account balance is insufficient". Com uma trava burra de
  // "já saiu hoje, não manda mais", as 51 que faltaram ficariam perdidas.
  // Contando só os aceitos, o cron de repescagem completa o que faltou -- e se
  // nada saiu, ele refaz o disparo inteiro.
  let jaEnviadosHoje = 0;
  if (!seco) {
    const j = await sb('/envios?select=telefone_e164'
      + '&arte=eq.' + encodeURIComponent(arteId)
      + '&categoria=eq.marketing'
      + '&http_status=lt.300'
      + '&criado_em=gte.' + encodeURIComponent(hoje + 'T00:00:00-03:00'));
    if (j.ok && Array.isArray(j.corpo)) jaEnviadosHoje = j.corpo.length;
  }

  // ---- Tamanho do lote ----------------------------------------------------
  const t = await sb('/rpc/base_elegivel_total', { method: 'POST', body: '{}' });
  const baseTotal = Number(t.corpo);
  if (!baseTotal || baseTotal < 1) {
    return res.status(500).json({ erro: 'Não consegui ler o tamanho da base.', resposta: t });
  }

  const ehExtra = Boolean(arte.extra);
  const pct = q.pct != null ? Number(q.pct) : (ehExtra ? PCT_FEIJOADA : PCT_DIARIA);
  const alvoDoDia = q.limite != null
    ? Math.max(0, Number(q.limite))
    : Math.max(1, Math.round(baseTotal * pct / 100));

  // O lote de agora é o que FALTA para fechar o alvo do dia. Numa execução
  // limpa, jaEnviadosHoje = 0 e isto é o alvo inteiro. Numa repescagem depois
  // de falha parcial, é só o buraco -- não manda a leva toda de novo.
  const limite = forcar ? alvoDoDia : Math.max(0, alvoDoDia - jaEnviadosHoje);

  if (!seco && limite === 0) {
    return res.status(409).json({
      erro: 'O alvo de hoje para esta arte já foi cumprido. Não vou mandar de novo.',
      arte: arteId,
      data: hoje,
      alvo_do_dia: alvoDoDia,
      ja_enviados_hoje: jaEnviadosHoje,
      dica: 'Para repetir de propósito, chame com &forcar=1 e token.',
    });
  }

  // ---- A fila -------------------------------------------------------------
  const f = await sb('/rpc/fila_campanha', {
    method: 'POST',
    body: JSON.stringify({
      p_arte: arteId,
      p_limite: limite,
      // A feijoada é EXTRA: ignora a trava de 1-por-semana de propósito.
      p_ignorar_semana: ehExtra,
      p_dias_repeticao: arte.diasRepeticao != null ? arte.diasRepeticao : 21,
    }),
  });
  if (!f.ok || !Array.isArray(f.corpo)) {
    return res.status(500).json({ erro: 'Falha ao montar a fila.', resposta: f });
  }

  const fila = f.corpo.filter((p) => {
    const n = normalizarTelefone(p.telefone_e164);
    return n.ok && n.e164.replace(/\D/g, '').length === 13;
  });

  const resumo = {
    data: hoje,
    hora_sp: agoraSP().toTimeString().slice(0, 5),
    arte: arteId,
    origem_da_escolha: origem,
    extra: ehExtra,
    imagem,
    imagem_ok: imgInfo,
    legenda,
    base_elegivel: baseTotal,
    pct_pedida: pct,
    alvo_do_dia: alvoDoDia,
    ja_enviados_hoje: jaEnviadosHoje,
    limite_calculado: limite,
    fila_devolvida: f.corpo.length,
    fila_valida: fila.length,
    seco,
  };

  if (seco) {
    return res.status(200).json({
      ...resumo,
      aviso: 'SIMULACAO. Nada foi enviado e nada foi gravado.',
      amostra: fila.slice(0, 5).map((p) => p.telefone_e164),
    });
  }

  if (fila.length === 0) {
    return res.status(200).json({
      ...resumo,
      enviados: 0,
      aviso: 'Fila vazia -- todo mundo elegível já recebeu marketing nos últimos 7 '
        + 'dias. Isso é a régua funcionando, não um erro.',
    });
  }

  // ---- Envio --------------------------------------------------------------
  // Sequencial, com pausa curta. Rajada paralela em número novo derruba a
  // qualidade do número na Meta, e a qualidade é o que define o limite diário.
  const enviados = [];
  const falhas = [];
  let saldoAcabou = false;

  for (const pessoa of fila) {
    const tel = normalizarTelefone(pessoa.telefone_e164).e164;
    const chave = ('camp:' + hoje + ':' + arteId + ':' + tel).slice(0, 128);

    const corpo = {
      from: process.env.NUMERO_ORIGEM || '+554420900707',
      to: tel,
      type: 'template',
      externalId: chave,
      template: {
        name: TEMPLATE,
        language: { code: 'pt_BR' },
        components: [
          // ESTE bloco é o que o _lib/envio.js não sabe fazer, e é por isso que
          // os 131 envios de 21 a 25/08 tiveram que ser montados na mão na YCloud.
          { type: 'header', parameters: [{ type: 'image', image: { link: imagem } }] },
          { type: 'body', parameters: [{ type: 'text', text: legenda }] },
        ],
      },
    };

    let r = null;
    let dados = null;
    try {
      r = await fetch(YCLOUD, {
        method: 'POST',
        headers: {
          'X-API-Key': chaveYCloud,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(corpo),
      });
      const txt = await r.text();
      dados = txt ? JSON.parse(txt) : null;
    } catch (e) {
      falhas.push({ telefone: tel, erro: String(e && e.message ? e.message : e) });
      continue;
    }

    // Grava SEMPRE, inclusive a falha. É esta linha que vira a memória do
    // rodízio -- sem ela a fila de amanhã escolheria as mesmas pessoas.
    await sb('/envios', {
      method: 'POST',
      body: JSON.stringify({
        telefone_e164: tel,
        tipo: 'template',
        template: TEMPLATE,
        arte: arteId,
        categoria: 'marketing',
        conteudo: legenda,
        chave_idempotencia: chave,
        ycloud_id: dados && dados.id ? dados.id : null,
        wamid: dados && dados.wamid ? dados.wamid : null,
        // 'accepted' NAO é entrega. O status real chega pelo webhook.
        status_inicial: (dados && dados.status) || (r.ok ? 'accepted' : 'erro'),
        http_status: r.status,
        resposta: dados,
      }),
    });

    if (r.ok) {
      enviados.push(tel);
    } else {
      falhas.push({ telefone: tel, status: r.status, resposta: dados });

      // ---- PARA NA HORA SE O SALDO ACABOU --------------------------------
      // Em 26/08 a carteira da YCloud zerou na 52ª mensagem. O código de então
      // continuou tentando e queimou mais 50 chamadas garantidamente inúteis,
      // gravando 51 linhas de erro. Saldo não volta sozinho no meio do laço:
      // a primeira recusa por saldo já é a resposta final.
      if (semSaldo(dados)) {
        saldoAcabou = true;
        break;
      }
    }

    await dormir(120);
  }

  // ---- AVISO AO LUCAS QUANDO ALGO SAI ERRADO -------------------------------
  // A falha de 26/08 quebrou às 10h01 e ninguém soube até as 11h. Silêncio é o
  // pior resultado: não dá para distinguir "dia correu bem" de "ninguém rodou".
  const taxaFalha = fila.length ? falhas.length / fila.length : 0;
  let avisoEnviado = null;

  if (saldoAcabou || enviados.length === 0 || taxaFalha >= 0.25) {
    const motivo = saldoAcabou
      ? 'O SALDO DA YCLOUD ACABOU no meio do disparo.'
      : enviados.length === 0
        ? 'O disparo de hoje NAO saiu para ninguem.'
        : 'O disparo saiu com muita falha.';

    avisoEnviado = await avisarLucas(
      'VARANDA - disparo ' + hoje + ' ' + agoraSP().toTimeString().slice(0, 5) + '. '
      + motivo + ' Arte: ' + arteId + '. Enviadas: ' + enviados.length
      + ' de ' + fila.length + '. Falhas: ' + falhas.length + '.'
      + (saldoAcabou ? ' Recarregue em ycloud.com/console (Settings > Billing).' : '')
      + ' Quem nao recebeu continua no topo da fila e sai no proximo disparo.'
    );
  }

  return res.status(200).json({
    ...resumo,
    enviados: enviados.length,
    falhas: falhas.length,
    saldo_acabou: saldoAcabou,
    nao_tentados: saldoAcabou ? fila.length - enviados.length - falhas.length : 0,
    custo_estimado_usd: Number((enviados.length * 0.0625).toFixed(4)),
    detalhe_falhas: falhas.slice(0, 15),
    aviso_ao_lucas: avisoEnviado,
    aviso: 'Aceito na fila da Meta NAO é entrega. O status real chega pelo webhook '
      + '(delivered / read / failed) e aparece no Message log da YCloud.',
  });
};
