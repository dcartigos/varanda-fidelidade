// POST /api/coleta
//
// A PORTA DO COLETOR PARA O BANCO.
//
// ============================================================================
// POR QUE ESTE ARQUIVO EXISTE
// ============================================================================
// Em 25/08/2026 o Coletor (que roda numa conversa do Claude, no PC do Varanda)
// avisou, antes de qualquer execução: **ele não tem nenhuma ferramenta de banco
// de dados.** Só navegador. E o arquivo de instruções que eu escrevi pedia
// `insert into` e `update` diretos no Supabase em sete passos diferentes.
//
// Erro meu de desenho. Ele fez o certo: preferiu parar a fingir que gravou.
//
// A correção usa o padrão que já funcionava no coleta_nomos.js: o Coletor não
// fala com o banco, fala com ESTE endpoint, com o IMPORT_TOKEN que já está no
// navegador. Toda escrita acontece aqui, no servidor, onde a service_role vive.
//
// Isso também melhora a segurança: a chave do banco nunca chega perto de um
// navegador, e a validação dos números passa a ser código em vez de instrução
// em português que alguém pode reinterpretar.
//
// ============================================================================
// COMO USAR — sempre POST, sempre com { acao, ... }
// ============================================================================
//
//   { "acao": "inicio" }
//        abre coleta_status do dia (completa=false) e uma linha em execucoes_log
//        devolve { execucao_id }
//
//   { "acao": "pedidos", "lidos": 214, "tem_pedidos_de_hoje": true }
//
//   { "acao": "pontos", "clientes": [ {"telefone":"...", "saldo":123}, ... ] }
//        normaliza e valida cada telefone AQUI. Devolve quantos gravou e quantos
//        recusou, com o motivo.
//
//   { "acao": "buffet", "kg":19.37, "valor_kg":1644.34,
//     "livre_qtd":2, "livre_valor":139.80 }
//        valida os preços. Se não fechar, NÃO grava e devolve o motivo.
//
//   { "acao": "despesas", "total": 1234.56 }
//
//   { "acao": "ifood", "itens":[ {"mes":"2026-08-01","loja":"...",
//     "nota":4.7,"faturamento":12345.67} ] }
//
//   { "acao": "concluir" }
//        marca completa=true SÓ se pedidos+pontos+buffet estiverem ok.
//        Devolve pode_enviar (o coleta_confiavel()).
//
//   { "acao": "fechar_log", "execucao_id": 12, "detalhe": {...} }

const { supabaseConfigurado } = require('./_lib/supabase');
const { normalizarTelefone } = require('./_lib/telefone');

const ORIGENS_PERMITIDAS = [
  'https://www.nomosmenu.com.br',
  'https://nomosmenu.com.br',
  'https://varanda-backend.vercel.app',
  'https://dcartigos.github.io',
  'https://portal.ifood.com.br',
];

// Validações de preço. Números confirmados pelo Lucas em 18/08/2026.
const PRECO_BUFFET_LIVRE = 69.90;   // sábado 79,90 — a tolerância cobre
const PRECO_KG = 84.00;             // R$ 8,40 por 100g
const TOLERANCIA = 0.20;            // 20%

function aplicarCors(req, res) {
  const origem = req.headers.origin;
  if (origem && ORIGENS_PERMITIDAS.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-varanda-token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
}

const limpar = (v) => String(v == null ? '' : v).trim();

/**
 * Converte para número aceitando número puro e formato brasileiro.
 *
 * ⚠️ BUG CORRIGIDO EM 25/08/2026 — NÃO VOLTE A APAGAR TODOS OS PONTOS.
 *
 * A versão anterior fazia `String(v).replace(/\./g,'')` sempre, para entender
 * "1.598,42". Só que isso destrói número normal: o ponto decimal ia embora e o
 * valor era multiplicado por 10, 100 ou 1000 — dependendo de quantas casas
 * decimais tivesse.
 *
 *    139.80  -> 1398     (10x)
 *    19.37   -> 1937     (100x)
 *    2.372   -> 2372     (1000x)
 *
 * Por isso o Coletor via "no kg preciso multiplicar por 10, no buffet livre
 * dividir por 10": não era campo, era casa decimal. E ele acertou em RECUSAR
 * compensar o valor à mão em vez de gravar número fabricado no banco
 * financeiro do restaurante.
 *
 * Regra: só trata como formato brasileiro quando existe VÍRGULA. Sem vírgula,
 * o ponto é decimal e fica onde está.
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  let s = String(v).trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (s.includes(',')) {
    // "1.598,42" ou "1598,42" -> ponto é separador de milhar
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function sb(caminho, opcoes) {
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1' + caminho, Object.assign({
    headers: {
      apikey: chave,
      Authorization: 'Bearer ' + chave,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  }, opcoes || {}));
  const txt = await r.text();
  return { ok: r.ok, status: r.status, corpo: txt ? JSON.parse(txt) : null };
}

/** Data de hoje no fuso de Brasília, em AAAA-MM-DD. */
function hojeBR() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

async function upsertStatus(campos) {
  return sb('/coleta_status', {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(Object.assign({ dia: hojeBR(), atualizado_em: new Date().toISOString() }, campos)),
  });
}

module.exports = async function handler(req, res) {
  aplicarCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') return responder(res, 405, { erro: 'Use POST.' });

  const recebido = limpar(req.headers['x-varanda-token'] || (req.query && req.query.token));
  const aceitos = [process.env.IMPORT_TOKEN, process.env.TESTE_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean).map(limpar);
  if (!recebido || !aceitos.includes(recebido)) {
    return responder(res, 401, { erro: 'Token inválido.' });
  }
  if (!supabaseConfigurado()) {
    return responder(res, 500, { erro: 'Supabase não configurado.' });
  }

  let c = req.body;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch (_) { c = null; } }
  c = c || {};
  const acao = limpar(c.acao);
  const dia = hojeBR();

  // ------------------------------------------------------------------ INICIO
  if (acao === 'inicio') {
    await upsertStatus({ iniciada_em: new Date().toISOString(), completa: false });
    const l = await sb('/execucoes_log', {
      method: 'POST',
      body: JSON.stringify({ rotina: 'coletor', mensagem: 'iniciado' }),
    });
    const id = (l.ok && Array.isArray(l.corpo) && l.corpo[0]) ? l.corpo[0].id : null;
    return responder(res, 200, { ok: true, dia, execucao_id: id });
  }

  // ----------------------------------------------------------------- PEDIDOS
  if (acao === 'pedidos') {
    const tem = c.tem_pedidos_de_hoje === true;
    if (!tem) {
      return responder(res, 400, {
        erro: 'tem_pedidos_de_hoje é false.',
        o_que_fazer: 'PARE e avise o Lucas. Ou o caixa não lançou nada, ou o filtro de data quebrou.',
      });
    }
    await upsertStatus({ pedidos_gravados: Number(c.lidos) || 0, tem_pedidos_de_hoje: true });
    return responder(res, 200, { ok: true, pedidos_gravados: Number(c.lidos) || 0 });
  }

  // ------------------------------------------------------------------ PONTOS
  if (acao === 'pontos') {
    const lista = Array.isArray(c.clientes) ? c.clientes : [];
    if (!lista.length) return responder(res, 400, { erro: 'Lista "clientes" vazia.' });

    const gravar = [];
    const recusados = [];

    for (const item of lista) {
      const tel = normalizarTelefone(item && item.telefone);
      const saldo = Number(item && item.saldo);

      if (!tel.ok) { recusados.push({ recebido: item && item.telefone, motivo: tel.motivo }); continue; }
      if (!Number.isFinite(saldo) || saldo < 0) {
        recusados.push({ telefone: tel.e164, motivo: 'saldo não é número válido' }); continue;
      }
      // A trava dos 13 dígitos vive no telefone.js, mas confirmo aqui também:
      // número de 12 dígitos vira mensagem que a Meta aceita e nunca entrega.
      if (tel.e164.replace(/\D/g, '').length !== 13) {
        recusados.push({ telefone: tel.e164, motivo: 'E.164 sem 13 dígitos' }); continue;
      }
      gravar.push({ telefone_e164: tel.e164, saldo_pontos: saldo });
    }

    let gravados = 0;
    for (const g of gravar) {
      const r = await sb('/base_clientes?telefone_e164=eq.' + encodeURIComponent(g.telefone_e164), {
        method: 'PATCH',
        body: JSON.stringify({
          saldo_pontos: g.saldo_pontos,
          saldo_atualizado_em: new Date().toISOString(),
        }),
      });
      if (r.ok && Array.isArray(r.corpo) && r.corpo.length) gravados++;
      else recusados.push({ telefone: g.telefone_e164, motivo: 'telefone não existe em base_clientes' });
    }

    await upsertStatus({ clientes_com_saldo: gravados });

    return responder(res, 200, {
      ok: true, recebidos: lista.length, gravados,
      recusados: recusados.length, detalhe_recusados: recusados.slice(0, 30),
    });
  }

  // ------------------------------------------------------------------ BUFFET
  if (acao === 'buffet') {
    const kg = num(c.kg), valorKg = num(c.valor_kg);
    const qtd = num(c.livre_qtd), valorLivre = num(c.livre_valor);
    const problemas = [];

    // ⚠️ VALIDAÇÃO EM CÓDIGO, NÃO EM PORTUGUÊS.
    // Antes isso era uma instrução escrita que dependia de alguém conferir.
    // 193 kg passa por 19 kg se ninguém validar — e o relatório vai para 3 pessoas.
    if (kg && valorKg) {
      const precoReal = valorKg / kg;
      if (Math.abs(precoReal - PRECO_KG) / PRECO_KG > TOLERANCIA) {
        problemas.push('buffet por kg: R$ ' + valorKg.toFixed(2) + ' / ' + kg +
          ' kg = R$ ' + precoReal.toFixed(2) + '/kg, esperado ~R$ ' + PRECO_KG.toFixed(2));
      }
    }
    if (qtd && valorLivre) {
      const esperado = qtd * PRECO_BUFFET_LIVRE;
      if (Math.abs(valorLivre - esperado) / esperado > TOLERANCIA) {
        problemas.push('buffet livre: ' + qtd + ' x R$ ' + PRECO_BUFFET_LIVRE.toFixed(2) +
          ' = R$ ' + esperado.toFixed(2) + ', mas veio R$ ' + valorLivre.toFixed(2));
      }
    }

    if (problemas.length) {
      await upsertStatus({ buffet_gravado: false, observacoes: problemas.join(' | ') });
      return responder(res, 400, {
        erro: 'Validação de preço não fechou. NÃO gravei.',
        problemas,
        o_que_fazer: 'Confira a leitura no Nomos. Se estiver certa mesmo, avise o Lucas — ' +
          'o preço pode ter mudado e a trava precisa ser atualizada.',
      });
    }

    const g = await sb('/buffet_dia', {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        dia, kg, valor_kg: valorKg, livre_qtd: qtd, livre_valor: valorLivre,
        gravado_em: new Date().toISOString(),
      }),
    });
    if (!g.ok) return responder(res, 502, { erro: 'Falha ao gravar buffet.', detalhe: g.corpo });

    await upsertStatus({ buffet_gravado: true });
    return responder(res, 200, {
      ok: true, kg, valor_kg: valorKg, livre_qtd: qtd, livre_valor: valorLivre,
      validacao: 'preços conferem',
    });
  }

  // ---------------------------------------------------------------- DESPESAS
  if (acao === 'despesas') {
    const total = num(c.total);
    if (total === null) {
      return responder(res, 400, {
        erro: 'total ausente ou inválido.',
        o_que_fazer: 'NÃO invente zero. Deixe despesas_gravadas = false e siga.',
      });
    }
    const g = await sb('/despesas_dia', {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({ dia, total, gravado_em: new Date().toISOString() }),
    });
    if (!g.ok) return responder(res, 502, { erro: 'Falha ao gravar despesas.', detalhe: g.corpo });
    await upsertStatus({ despesas_gravadas: true });
    return responder(res, 200, { ok: true, total });
  }

  // ------------------------------------------------------------------- IFOOD
  if (acao === 'ifood') {
    const itens = Array.isArray(c.itens) ? c.itens : [];
    if (!itens.length) return responder(res, 400, { erro: 'Lista "itens" vazia.' });

    const linhas = itens.map((i) => ({
      mes: limpar(i.mes),
      loja: limpar(i.loja),
      nota_media: num(i.nota),
      faturamento_real: num(i.faturamento),
      atualizado_em: new Date().toISOString(),
    })).filter((l) => l.mes && l.loja);

    if (!linhas.length) return responder(res, 400, { erro: 'Nenhum item com mes e loja.' });

    const g = await sb('/ifood_mensal', {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(linhas),
    });
    if (!g.ok) return responder(res, 502, { erro: 'Falha ao gravar iFood.', detalhe: g.corpo });
    return responder(res, 200, { ok: true, gravados: linhas.length });
  }

  // ---------------------------------------------------------------- CONCLUIR
  if (acao === 'concluir') {
    const q = await sb('/coleta_status?select=*&dia=eq.' + dia);
    const s = (q.ok && Array.isArray(q.corpo) && q.corpo[0]) ? q.corpo[0] : null;
    if (!s) return responder(res, 400, { erro: 'Não existe coleta_status para hoje. Rode a ação "inicio".' });

    const faltando = [];
    if (!s.tem_pedidos_de_hoje) faltando.push('pedidos do dia');
    if (!s.clientes_com_saldo) faltando.push('saldo de pontos');
    if (!s.buffet_gravado) faltando.push('kg / buffet livre');

    if (faltando.length) {
      // Não marca completa. Ausência de dado não é zero.
      return responder(res, 400, {
        erro: 'Não posso declarar a coleta completa.',
        faltando,
        o_que_fazer: 'Complete os passos que faltam. Se algum não tiver como ser feito hoje, ' +
          'avise o Lucas — o relatório vai sair com "(não confirmado)" no que faltar.',
      });
    }

    await upsertStatus({ completa: true, concluida_em: new Date().toISOString() });

    const v = await sb('/rpc/coleta_confiavel', {
      method: 'POST', body: JSON.stringify({ p_dia: dia }),
    });
    const podeEnviar = v.ok && (v.corpo === true || v.corpo === 'true');

    return responder(res, 200, {
      ok: true, completa: true, pode_enviar: podeEnviar,
      proximo_passo: podeEnviar
        ? 'Chamar /api/rotina-diaria com &seco=1 para conferir, e depois sem o seco=1 para enviar.'
        : 'coleta_confiavel() deu false. NÃO chame a rotina. Avise o Lucas.',
      despesas_gravadas: !!s.despesas_gravadas,
    });
  }

  // -------------------------------------------------------------- FECHAR LOG
  if (acao === 'fechar_log') {
    const id = Number(c.execucao_id);
    if (!id) return responder(res, 400, { erro: 'execucao_id é obrigatório.' });
    await sb('/execucoes_log?id=eq.' + id, {
      method: 'PATCH',
      body: JSON.stringify({
        terminado_em: new Date().toISOString(),
        sucesso: c.sucesso !== false,
        detalhe: c.detalhe || null,
        mensagem: limpar(c.mensagem) || null,
      }),
    });
    return responder(res, 200, { ok: true });
  }

  return responder(res, 400, {
    erro: 'Ação desconhecida: ' + (acao || '(vazia)'),
    acoes: ['inicio', 'pedidos', 'pontos', 'buffet', 'despesas', 'ifood', 'concluir', 'fechar_log'],
  });
};
