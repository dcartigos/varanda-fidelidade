// GET /api/backfill-pontos?dia=YYYY-MM-DD
//
// Reenvio avulso dos PONTOS de fidelidade de um dia específico, para quando a
// rotina normal (api/rotina-diaria) não rodou naquele dia, ou rodou com dado
// faltando no banco (foi o caso de 21/08/2026: o bug do encodeURIComponent
// fez com_saldo sair 0, então a rotina daquele dia não mandou nada).
//
// Este endpoint SÓ manda PONTOS. Não manda o fechamento — não faz sentido
// mandar um relatório de caixa de um dia que já passou, fora de hora.
//
// A lógica de busca é uma cópia da PARTE 1 de api/rotina-diaria.js (já com a
// correção do encodeURIComponent nos telefones do filtro in.()). Se um dia
// mudar a lógica de lá, replicar aqui também.
//
// Autenticação: os mesmos três tokens aceitos em rotina-diaria.js (token via
// query ou header x-varanda-token — TESTE_TOKEN, IMPORT_TOKEN ou APP_TOKEN).
// Não existe caminho de cron aqui: isto é sempre disparado manualmente.
//
// Parâmetro obrigatório: dia=YYYY-MM-DD
// Parâmetro opcional: seco=1 (só simula — mostra quem receberia o quê, não manda nada)

const { supabaseConfigurado } = require('./_lib/supabase');

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
}

async function sb(caminho, opcoes) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(url + '/rest/v1' + caminho, Object.assign({
    headers: {
      apikey: chave,
      Authorization: 'Bearer ' + chave,
      'Content-Type': 'application/json',
    },
  }, opcoes || {}));
  const txt = await r.text();
  return { ok: r.ok, status: r.status, corpo: txt ? JSON.parse(txt) : null };
}

/** Chama o nosso próprio /api/enviar. O token vem do ambiente, não do cliente. */
async function enviar(payload) {
  const base = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '';
  const r = await fetch(base + '/api/enviar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-varanda-token': process.env.APP_TOKEN },
    body: JSON.stringify(payload),
  });
  const corpo = await r.json().catch(() => ({}));
  return { status: r.status, aceito: !!corpo.aceito, erro: corpo.erro || corpo.motivo || null };
}

module.exports = async function handler(req, res) {
  const recebido = (req.query && req.query.token) || req.headers['x-varanda-token'];
  const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean);
  if (!recebido || !aceitos.includes(recebido)) {
    return responder(res, 401, {
      erro: 'Token inválido.',
      dica: 'Use ?token=SEU_TESTE_TOKEN (a variável TESTE_TOKEN do Vercel).',
    });
  }
  if (!supabaseConfigurado()) {
    return responder(res, 500, { erro: 'Supabase não configurado.' });
  }

  const dia = req.query && req.query.dia;
  if (!dia || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
    return responder(res, 400, { erro: 'Parâmetro dia=YYYY-MM-DD é obrigatório.' });
  }
  const seco = req.query && (req.query.seco === '1' || req.query.seco === 'true');

  const inicio = dia + 'T00:00:00-03:00';
  const fimDate = new Date(dia + 'T00:00:00Z');
  fimDate.setUTCDate(fimDate.getUTCDate() + 1);
  const fim = fimDate.toISOString().slice(0, 10) + 'T00:00:00-03:00';

  const doDia = await sb(
    '/nomos_pedidos?select=codigo,telefone_e164,data_hora_pedido' +
    '&data_hora_pedido=gte.' + encodeURIComponent(inicio) +
    '&data_hora_pedido=lt.' + encodeURIComponent(fim) +
    '&telefone_valido=is.true&order=data_hora_pedido.desc&limit=500'
  );
  const pedidosDoDia = (doDia.ok && Array.isArray(doDia.corpo)) ? doDia.corpo : [];

  // último pedido de cada telefone, só 13 dígitos
  const ultimoPedido = {};
  for (const p of pedidosDoDia) {
    const dig = String(p.telefone_e164 || '').replace(/\D/g, '');
    if (dig.length !== 13) continue;
    if (!ultimoPedido[p.telefone_e164]) ultimoPedido[p.telefone_e164] = p;
  }
  const telefones = Object.keys(ultimoPedido);

  let saldos = {};
  let semSaldo = [];
  if (telefones.length) {
    const q = await sb('/base_clientes?select=telefone_e164,saldo_pontos,sem_whatsapp' +
      '&telefone_e164=in.(' + telefones.map((t) => '"' + encodeURIComponent(t) + '"').join(',') + ')');
    for (const c of (q.ok && Array.isArray(q.corpo) ? q.corpo : [])) {
      if (c.sem_whatsapp) continue;
      if (c.saldo_pontos === null || c.saldo_pontos === undefined) { semSaldo.push(c.telefone_e164); continue; }
      saldos[c.telefone_e164] = c.saldo_pontos;
    }
  }

  const alvos = Object.keys(saldos);
  const resultado = {
    dia,
    seco,
    clientes_do_dia: telefones.length,
    com_saldo: alvos.length,
    sem_saldo_no_banco: semSaldo.length,
    enviados: 0,
    recusados: 0,
    detalhe: [],
  };

  if (semSaldo.length && !alvos.length) {
    resultado.aviso =
      'Nenhum cliente desse dia tem saldo_pontos no banco. NÃO inventei saldo — nada foi enviado.';
  }

  for (const tel of alvos) {
    const p = ultimoPedido[tel];
    const data = new Date(p.data_hora_pedido);
    const dataBR = String(data.getUTCDate()).padStart(2, '0') + '/' +
      String(data.getUTCMonth() + 1).padStart(2, '0') + '/' + data.getUTCFullYear();
    if (seco) { resultado.detalhe.push(tel + ' -> ' + saldos[tel] + ' pts (simulado)'); continue; }
    const r = await enviar({
      telefone: tel,
      template: 'atualizacao_cadastro_pontos',
      idioma: 'pt_BR',
      parametros: [String(p.codigo), dataBR, String(saldos[tel])],
      chave: 'pontos|' + tel + '|' + dia,
      forcar: true,
    });
    if (r.aceito) resultado.enviados++;
    else { resultado.recusados++; resultado.detalhe.push(tel + ': ' + r.erro); }
    await new Promise((x) => setTimeout(x, 300));
  }

  resultado.aviso_geral =
    '"enviados" aqui significa ACEITO pela fila da Meta, não entregue. Confira o status real em ' +
    '/api/status?minutos=15 ou na tabela status_mensagens.';

  return responder(res, 200, resultado);
};

