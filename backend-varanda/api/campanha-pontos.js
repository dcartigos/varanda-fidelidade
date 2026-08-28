// GET /api/campanha-pontos
//
// A CAMPANHA DO RESGATE DE PONTOS (27/08/2026).
//
// Manda o template Marketing `resgate_pontos_fidelidade` para quem tem
// 100+ pontos (= R$ 10+, o mínimo que dá para resgatar no caixa).
//
// COMO USAR — sempre com ?token=...
//
//   &seco=1            -> NÃO envia nada. Mostra a fila: quantos, custo,
//                         primeiros da lista. É o padrão seguro.
//   &disparar=sim      -> envia UM LOTE de até 45 e devolve quantos faltam.
//                         Chamar de novo até restantes=0. A idempotência
//                         (chave resgate|tel|AAAA-MM) garante que rodar
//                         duas vezes NÃO manda duas vezes para ninguém.
//
// POR QUE LOTES DE 45: a função da Vercel tem limite de tempo. 128 envios
// com espaçamento de 400ms passam de 1 minuto — cortaria no meio e ninguém
// saberia onde parou. 45 por chamada terminam em ~20s com folga.
//
// AS TRAVAS (todas em código, nenhuma em português):
//   1. só saldo_pontos >= 100 (quem pode resgatar de verdade)
//   2. sem_whatsapp = false
//   3. fora da bloqueios_marketing (quem pediu SAIR nunca recebe)
//   4. ordem CRESCENTE de saldo (decisão do Lucas, 26/08: erro aparece
//      nos saldos pequenos, não nos melhores clientes)
//   5. valor NUNCA inventado: R$ = pontos * 0,10 (1 ponto por R$ 1 gasto,
//      cashback 10% — print do Nomos, 26/08)
//   6. chave mensal: cada cliente recebe NO MÁXIMO 1 por mês
//   7. teto absoluto de 150 envios por dia nesta campanha

const { supabaseConfigurado } = require('./_lib/supabase');

// ----------------------------------------------------------------------------
// AS DUAS CAMPANHAS (28/08/2026): &faixa=resgate (padrão) ou &faixa=quase.
//   resgate -> 100+ pontos, template resgate_pontos_fidelidade,
//              params [nome, pontos, valor R$]
//   quase   -> 70 a 99 pontos, template quase_la_pontos,
//              params [nome, pontos]  (sem valor — ainda não resgata)
// Chaves de idempotência separadas (resgate| e quase|): uma campanha nunca
// bloqueia nem duplica a outra.
// ----------------------------------------------------------------------------
const CAMPANHAS = {
  resgate: {
    template: 'resgate_pontos_fidelidade',
    saldo_min: 100, saldo_max: null,
    prefixo_chave: 'resgate',
  },
  quase: {
    template: 'quase_la_pontos',
    saldo_min: 70, saldo_max: 99,
    prefixo_chave: 'quase',
  },
};

const LOTE_MAXIMO = 45;
const TETO_DIARIO = 150;

const ORIGENS_PERMITIDAS = [
  'https://www.nomosmenu.com.br',
  'https://nomosmenu.com.br',
  'https://varanda-backend.vercel.app',
  'https://dcartigos.github.io',
];

function aplicarCors(req, res) {
  const origem = req.headers.origin;
  if (origem && ORIGENS_PERMITIDAS.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-varanda-token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
}

async function sb(caminho, opcoes) {
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1' + caminho, Object.assign({
    headers: {
      apikey: chave,
      Authorization: 'Bearer ' + chave,
      'Content-Type': 'application/json',
    },
  }, opcoes || {}));
  const txt = await r.text();
  return { ok: r.ok, status: r.status, corpo: txt ? JSON.parse(txt) : null };
}

async function enviar(payload) {
  const base = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '';
  const r = await fetch(base + '/api/enviar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-varanda-token': String(process.env.APP_TOKEN || '').trim(),
    },
    body: JSON.stringify(payload),
  });
  const corpo = await r.json().catch(() => ({}));
  return { status: r.status, aceito: !!corpo.aceito, erro: corpo.erro || corpo.motivo || null };
}

/** Primeiro nome, capitalizado. "MARIA JOSE" -> "Maria". */
function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || 'cliente';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

/** R$ com vírgula. 230 pontos -> "23,00". Nunca inventa: só multiplica. */
function valorBR(pontos) {
  return (Number(pontos) * 0.10).toLocaleString('pt-BR',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = async function handler(req, res) {
  aplicarCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') return responder(res, 405, { erro: 'Use GET.' });

  const recebido = String((req.query && req.query.token) || req.headers['x-varanda-token'] || '').trim();
  const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean).map((t) => String(t).trim());
  if (!recebido || !aceitos.includes(recebido)) {
    return responder(res, 401, { erro: 'Token inválido.' });
  }
  if (!supabaseConfigurado()) {
    return responder(res, 500, { erro: 'Supabase não configurado.' });
  }

  const disparar = req.query && req.query.disparar === 'sim';
  const agoraBR = new Date(Date.now() - 3 * 3600 * 1000);
  const hoje = agoraBR.toISOString().slice(0, 10);
  const mes = hoje.slice(0, 7); // AAAA-MM — chave mensal

  const nomeCampanha = (req.query && req.query.faixa) || 'resgate';
  const camp = CAMPANHAS[nomeCampanha];
  if (!camp) {
    return responder(res, 400, { erro: 'faixa desconhecida. Use faixa=resgate ou faixa=quase.' });
  }

  // ---------------------------------------------------------------- A FILA
  // Quem tem 100+ pontos, tem WhatsApp, não pediu SAIR, e AINDA NÃO recebeu
  // a campanha deste mês. Ordem crescente de saldo.

  const bloq = await sb('/bloqueios_marketing?select=telefone_e164');
  const bloqueados = new Set(
    (bloq.ok && Array.isArray(bloq.corpo) ? bloq.corpo : []).map((b) => b.telefone_e164)
  );

  const jaFoi = await sb('/envios?select=telefone_e164&chave_idempotencia=like.' +
    encodeURIComponent(camp.prefixo_chave + '|*|' + mes));
  const jaReceberam = new Set(
    (jaFoi.ok && Array.isArray(jaFoi.corpo) ? jaFoi.corpo : []).map((e) => e.telefone_e164)
  );

  const q = await sb('/base_clientes?select=telefone_e164,nome,saldo_pontos' +
    '&saldo_pontos=gte.' + camp.saldo_min +
    (camp.saldo_max ? '&saldo_pontos=lte.' + camp.saldo_max : '') +
    '&or=(sem_whatsapp.is.null,sem_whatsapp.is.false)' +
    '&order=saldo_pontos.asc&limit=600');
  if (!q.ok) return responder(res, 502, { erro: 'Falha ao ler base_clientes.', detalhe: q.corpo });

  const fila = (q.corpo || []).filter((c) =>
    !bloqueados.has(c.telefone_e164) && !jaReceberam.has(c.telefone_e164)
  );

  const enviadosHoje = jaReceberam.size;
  const cabemHoje = Math.max(0, TETO_DIARIO - enviadosHoje);
  const lote = fila.slice(0, Math.min(LOTE_MAXIMO, cabemHoje));

  const resultado = {
    dia: hoje,
    campanha: nomeCampanha + ' (' + camp.template + ', saldo ' + camp.saldo_min +
      (camp.saldo_max ? '-' + camp.saldo_max : '+') + ')',
    modo: disparar ? 'DISPARO REAL' : 'prévia (seco) — nada enviado',
    fila_total: fila.length,
    ja_receberam_no_mes: enviadosHoje,
    bloqueados_sair: bloqueados.size,
    lote_desta_chamada: lote.length,
    restantes_apos_este_lote: Math.max(0, fila.length - lote.length),
    custo_estimado_do_lote_usd: +(lote.length * 0.0625).toFixed(2),
    amostra: lote.slice(0, 5).map((c) => ({
      nome: primeiroNome(c.nome),
      final_tel: String(c.telefone_e164).slice(-4),
      pontos: c.saldo_pontos,
      valor: 'R$ ' + valorBR(c.saldo_pontos),
    })),
  };

  if (!disparar) {
    resultado.como_disparar = 'Adicione &disparar=sim. Repita a chamada até restantes_apos_este_lote = 0.';
    return responder(res, 200, resultado);
  }

  // -------------------------------------------------------------- O DISPARO
  const log = await sb('/execucoes_log', {
    method: 'POST',
    headers: { Prefer: 'return=representation', apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rotina: 'campanha-pontos', mensagem: 'lote iniciado: ' + lote.length }),
  });
  const logId = (log.ok && Array.isArray(log.corpo) && log.corpo[0]) ? log.corpo[0].id : null;

  resultado.enviados = 0;
  resultado.falharam = 0;
  resultado.detalhe_falhas = [];

  for (const c of lote) {
    const r = await enviar({
      telefone: c.telefone_e164,
      template: camp.template,
      idioma: 'pt_BR',
      // resgate: [nome, pontos, valor] · quase: [nome, pontos] — o número de
      // parâmetros PRECISA bater com o template aprovado (erro 132000 se não).
      parametros: nomeCampanha === 'quase'
        ? [primeiroNome(c.nome), String(c.saldo_pontos)]
        : [primeiroNome(c.nome), String(c.saldo_pontos), valorBR(c.saldo_pontos)],
      chave: camp.prefixo_chave + '|' + c.telefone_e164 + '|' + mes,
      // SEM forcar: se a chave já existe, o servidor recusa — é a garantia
      // de no máximo 1 por cliente por mês, mesmo rodando isto 10 vezes.
    });
    if (r.aceito) resultado.enviados++;
    else {
      resultado.falharam++;
      resultado.detalhe_falhas.push(String(c.telefone_e164).slice(-4) + ': ' + r.erro);
    }
    await new Promise((x) => setTimeout(x, 400));
  }

  if (logId) {
    await sb('/execucoes_log?id=eq.' + logId, {
      method: 'PATCH',
      body: JSON.stringify({
        terminado_em: new Date().toISOString(),
        sucesso: resultado.falharam === 0,
        enviados: resultado.enviados,
        falhados: resultado.falharam,
        mensagem: 'lote concluído',
      }),
    });
  }

  resultado.aviso = '"enviados" = aceito na fila da Meta. Entrega real: /api/status?minutos=30.';
  resultado.proximo_passo = resultado.restantes_apos_este_lote > 0
    ? 'Chamar de novo com &disparar=sim para o próximo lote.'
    : 'Fila zerada. Conferir entrega no /api/status.';

  return responder(res, 200, resultado);
};
