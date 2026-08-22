// GET /api/rotina-diaria
//
// A ROTINA DIÁRIA COMPLETA, RODANDO NO SERVIDOR.
// Manda os pontos para quem veio hoje E o relatório de fechamento para a equipe.
//
// ============================================================================
// POR QUE ESTE ARQUIVO EXISTE — leia antes de mexer
// ============================================================================
//
// Até 21/08/2026 o envio dependia de um segredo (APP_TOKEN) guardado no
// localStorage do navegador de UM computador. Isso quebrou de quatro formas
// diferentes em dois dias:
//
// 1. o token nunca foi colado no PC do Varanda -> 20/08, nada saiu
// 2. o token foi rotacionado e o valor se perdeu -> era Sensitive no Vercel
// 3. o navegador do PC estava com localStorage vazio
// 4. o classificador de segurança do assistente bloqueou ler o token
//
// Nenhuma dessas é um bug de código. Todas são consequência da MESMA decisão de
// arquitetura errada: **pedir para o cliente guardar um segredo**.
//
// A correção é inverter os papéis:
//
// ANTES: o PC lê o Nomos, monta a mensagem e ENVIA (precisa do token)
// AGORA: o PC lê o Nomos e só GRAVA os números. O SERVIDOR envia.
//
// O APP_TOKEN nunca sai daqui. Ninguém copia, ninguém cola, ninguém perde.
//
// COMO É DISPARADO
// Vercel Cron, sem token nenhum: a Vercel chama internamente e manda o header
// 'x-vercel-cron'. Também dá para chamar na mão pelo navegador, com token.
//
// ⚠️ PLANO HOBBY: 1 cron por dia e precisão de ±59min. Por isso esta rotina faz
// as DUAS tarefas numa só chamada, às 14h30. No plano Pro dá para separar em
// 14h15 e 14h30 com precisão de minuto.
//
// ============================================================================
// DEGRADAÇÃO GRACIOSA — a parte mais importante do desenho
// ============================================================================
//
// kg vendido e buffet livre só existem no Nomos, que NÃO TEM API: ler exige um
// navegador logado. Essa parte continua dependendo do PC.
//
// Mas o relatório NÃO fica preso nisso. Se o PC não gravou os números do dia,
// o relatório sai com "(não confirmado)" nesses dois campos e avisa. Faturamento,
// pedidos e clientes vêm do banco e sempre saem.
//
// Antes: uma falha no PC = ninguém recebe nada.
// Agora: uma falha no PC = todos recebem 80% do relatório, e sabem o que faltou.
//
// ============================================================================
// 22/08/2026 — fim do fetch interno para /api/enviar
// ============================================================================
//
// Antes, esta função chamava o próprio /api/enviar por HTTP (self-fetch com
// process.env.APP_TOKEN no cabeçalho). Essa chamada quebrou em 21/08 ("Token
// inválido") sem que o teste seco=1 detectasse, porque seco=1 nunca chega a
// executar essa parte. Agora a lógica de envio vive em api/_lib/envio.js e é
// chamada direto, em memória — sem HTTP, sem token entre as duas partes do
// nosso próprio servidor.

const { supabaseConfigurado } = require('./_lib/supabase');
const { enviarMensagem } = require('./_lib/envio');

const EQUIPE = [
  { nome: 'Lucas', telefone: '+5544999691829', completo: true },
  { nome: 'Leopoldo', telefone: '+5524999410719', completo: true },
  { nome: 'Maria', telefone: '+5544997335705', completo: false }, // só clientes
];

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sábado'];

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
}

const dinheiro = (v) =>
  Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

module.exports = async function handler(req, res) {
  const doCron = !!req.headers['x-vercel-cron'];
  const recebido = (req.query && req.query.token) || req.headers['x-varanda-token'];
  const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean);
  if (!doCron && (!recebido || !aceitos.includes(recebido))) {
    return responder(res, 401, {
      erro: 'Token inválido.',
      dica: 'Use ?token=SEU_TESTE_TOKEN (a variável TESTE_TOKEN do Vercel).',
    });
  }
  if (!supabaseConfigurado()) {
    return responder(res, 500, { erro: 'Supabase não configurado.' });
  }

  const agoraBR = new Date(Date.now() - 3 * 3600 * 1000);
  const hoje = agoraBR.toISOString().slice(0, 10);
  const hojeBR = hoje.split('-').reverse().join('/');
  const diaSemana = DIAS[agoraBR.getUTCDay()];
  const seco = req.query && (req.query.seco === '1' || req.query.seco === 'true');

  if (agoraBR.getUTCDay() === 0) {
    return responder(res, 200, { dia: hoje, domingo: true, aviso: 'domingo, restaurante fechado' });
  }

  const resultado = { dia: hoje, seco, pontos: {}, fechamento: {} };

  const doDia = await sb(
    '/nomos_pedidos?select=codigo,telefone_e164,data_hora_pedido' +
    '&data_hora_pedido=gte.' + encodeURIComponent(hoje + 'T00:00:00-03:00') +
    '&telefone_valido=is.true&order=data_hora_pedido.desc&limit=500'
  );
  const pedidosHoje = (doDia.ok && Array.isArray(doDia.corpo)) ? doDia.corpo : [];

  const ultimoPedido = {};
  for (const p of pedidosHoje) {
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
  resultado.pontos = {
    clientes_hoje: telefones.length,
    com_saldo: alvos.length,
    sem_saldo_no_banco: semSaldo.length,
    enviados: 0, recusados: 0, detalhe: [],
  };

  if (semSaldo.length && !alvos.length) {
    resultado.pontos.aviso =
      'Nenhum cliente de hoje tem saldo_pontos no banco. O PC do Varanda precisa ' +
      'gravar os pontos do Nomos. NÃO inventei saldo — nada foi enviado.';
  }

  for (const tel of alvos) {
    const p = ultimoPedido[tel];
    const data = new Date(p.data_hora_pedido);
    const dataBR = String(data.getUTCDate()).padStart(2, '0') + '/' +
      String(data.getUTCMonth() + 1).padStart(2, '0') + '/' + data.getUTCFullYear();
    if (seco) { resultado.pontos.detalhe.push(tel + ' (simulado)'); continue; }
    const r = await enviarMensagem({
      telefone: tel,
      template: 'atualizacao_cadastro_pontos',
      idioma: 'pt_BR',
      parametros: [String(p.codigo), dataBR, String(saldos[tel])],
      chave: 'pontos|' + tel + '|' + hoje,
      forcar: true,
    });
    if (r.aceito) resultado.pontos.enviados++;
    else { resultado.pontos.recusados++; resultado.pontos.detalhe.push(tel + ': ' + (r.erro || r.motivo || 'falha desconhecida')); }
    await new Promise((x) => setTimeout(x, 300));
  }

  const num = await sb('/rpc/numeros_do_dia', {
    method: 'POST', body: JSON.stringify({ p_dia: hoje }),
  });

  let n = null;
  if (num.ok && num.corpo) n = Array.isArray(num.corpo) ? num.corpo[0] : num.corpo;

  if (!n) {
    resultado.fechamento.erro =
      'A função numeros_do_dia() não respondeu. Rode o SQL de 34_SQL_ROTINA_SERVIDOR.sql.';
    return responder(res, 200, resultado);
  }

  const buf = await sb('/buffet_dia?select=kg,valor_kg,livre_qtd,livre_valor&dia=eq.' + hoje);
  const b = (buf.ok && Array.isArray(buf.corpo) && buf.corpo[0]) ? buf.corpo[0] : null;

  const NC = '(não confirmado)';
  const linhaKg = b && b.kg
    ? dinheiro(b.kg) + ' kg (R$ ' + dinheiro(b.valor_kg) + ')'
    : NC;
  const linhaLivre = b && b.livre_qtd
    ? b.livre_qtd + ' pessoas (R$ ' + dinheiro(b.livre_valor) + ')'
    : NC;

  const pedidos = Number(n.pedidos || 0);
  const ident = Number(n.identificados || 0);
  const novos = Number(n.novos || 0);
  const pct = (v) => pedidos ? Math.round((v / pedidos) * 100) : 0;

  const blocoClientes =
    '*CLIENTES — ' + pedidos + ' pedidos*\n\n' +
    '• novos cadastros: ' + novos + '\n' +
    '• voltaram: ' + Math.max(0, ident - novos) + '\n' +
    '• identificados: ' + ident + ' (' + pct(ident) + '%)\n' +
    '• não cadastrados: ' + (pedidos - ident) + ' (' + pct(pedidos - ident) + '%)';

  const completo =
    '*VARANDA — ' + hojeBR + ' (' + diaSemana + ')*\n\n' +
    '*FATURAMENTO TOTAL: R$ ' + dinheiro(n.total) + '*\n\n' +
    '• salão: R$ ' + dinheiro(n.salao) + ' (' + (n.salao_qtd || 0) + ' pedidos)\n' +
    '• delivery: R$ ' + dinheiro(n.delivery) + ' (' + (n.delivery_qtd || 0) + ' pedidos)\n' +
    '• balcão: R$ ' + dinheiro(n.balcao) + ' (' + (n.balcao_qtd || 0) + ' pedidos)\n\n' +
    '=========================\n\n' +
    '*QUANTIDADE*\n\n' +
    '• buffet por kg: ' + linhaKg + '\n' +
    '• buffet livre: ' + linhaLivre + '\n\n' +
    '=========================\n\n' +
    blocoClientes + '\n\n' +
    '=========================\n\n' +
    (linhaKg === NC ? '_O PC do Varanda não gravou o kg de hoje._\n' : '') +
    '_Responda OK para manter o envio gratuito._';

  resultado.fechamento = {
    kg_confirmado: linhaKg !== NC,
    total: n.total, pedidos, identificados: ident, novos,
    enviados: 0, falharam: 0, detalhe: [],
    previa: seco ? completo : undefined,
  };

  if (!seco) {
    for (const p of EQUIPE) {
      const texto = p.completo ? completo :
        '*VARANDA — ' + hojeBR + '*\n\n' + blocoClientes +
        '\n\n_Responda OK para manter o envio gratuito._';
      const r = await enviarMensagem({
        telefone: p.telefone,
        texto,
        chave: 'fechamento|' + p.telefone + '|' + hoje,
        forcar: true,
      });
      if (r.aceito) resultado.fechamento.enviados++;
      else { resultado.fechamento.falharam++; resultado.fechamento.detalhe.push(p.nome + ': ' + (r.erro || r.motivo || 'falha desconhecida')); }
      await new Promise((x) => setTimeout(x, 400));
    }
  }

  resultado.aviso =
    'Os números de "enviados" são ACEITOS na fila da Meta. Entrega real só pelo ' +
    'webhook — consulte /api/status?minutos=15.';

  return responder(res, 200, resultado);
};
