// /api/nomos-sessao
//
// GUARDA E TESTA A SESSÃO DO NOMOS NO SERVIDOR.
//
// ============================================================================
// POR QUE ESTE ARQUIVO EXISTE
// ============================================================================
// Em 25/08/2026 descobrimos duas coisas no mesmo dia:
//
// 1. A tarefa agendada do app do Claude roda NA NUVEM, sem navegador. Foi por
//    isso que o Coletor ficava "Ativo", disparava no horário e não fazia nada.
//    Cinco dias caçando bug de token, de coluna e de telefone — todos reais e
//    corrigidos — quando a causa de "não roda sozinho" era outra: nenhuma
//    tarefa agendada nunca teve acesso ao Chrome.
//
// 2. O Nomos tem um endpoint JSON que resolve isso:
//
//        POST /app/varanda/gestorpedido/listarJson
//
//    Numa chamada só ele devolve os pedidos individuais, os produtos vendidos
//    com quantidade e unidade (o kg e o buffet livre, já numéricos), o
//    faturamento, os clientes novos e os totais separados de iFood, Aiqfome e
//    99food. Autenticação: só o cookie `sisfood_session`. Sem CSRF.
//
// Guardando esse cookie aqui, o servidor lê o Nomos direto. Sem navegador, sem
// PC ligado, sem ninguém clicando.
//
// ============================================================================
// REGRA DE OURO DESTE ARQUIVO
// ============================================================================
// O valor do cookie NUNCA sai daqui. Nenhuma resposta, nenhum log, nenhuma
// mensagem de erro contém o valor. Onde faria sentido mostrá-lo, mostramos o
// TAMANHO. Se algum dia alguém precisar "ver o cookie para conferir", a resposta
// é não — confere pelo tamanho e pelo teste de uso.
//
// ============================================================================
// COMO USAR
// ============================================================================
// 1) GUARDAR (uma vez, e de novo quando expirar)
//    Rodar no console do navegador, com o Nomos ABERTO e LOGADO:
//
//      await fetch('https://varanda-backend.vercel.app/api/nomos-sessao', {
//        method:'POST',
//        headers:{'Content-Type':'application/json','x-varanda-token':'SEU_TESTE_TOKEN'},
//        body: JSON.stringify({ cookie: document.cookie })
//      }).then(r=>r.json())
//
//    O valor vai direto do navegador para cá. Não passa por conversa nenhuma.
//
// 2) TESTAR
//      GET /api/nomos-sessao?token=SEU_TESTE_TOKEN&teste=1
//    Usa o cookie guardado para chamar o Nomos e devolve só a ESTRUTURA do que
//    voltou — contagens, nomes de campos. Nenhum dado de cliente.
//
// 3) CONSULTAR ESTADO
//      GET /api/nomos-sessao?token=SEU_TESTE_TOKEN
//    Diz se existe cookie, o tamanho, quando foi capturado e o último status.

const { supabaseConfigurado } = require('./_lib/supabase');

const NOMOS = 'https://www.nomosmenu.com.br';
const LISTAR = '/app/varanda/gestorpedido/listarJson';

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
}

const limpar = (v) => String(v == null ? '' : v).trim();

async function sb(caminho, opcoes) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(url + '/rest/v1' + caminho, Object.assign({
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

/** dd/mm/aaaa no fuso de Brasília */
function dataBR(deslocaDias) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 + (deslocaDias || 0) * 86400000);
  const dd = (n) => String(n).padStart(2, '0');
  return dd(d.getUTCDate()) + '/' + dd(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
}

/**
 * Chama o listarJson do Nomos com o cookie guardado.
 *
 * ⚠️ A DATA FINAL É AMANHÃ, DE PROPÓSITO. O Nomos trata dataFim como
 * "até aquele dia 00:00" e EXCLUI o dia inteiro. Com dataFim = hoje, a resposta
 * vem sem os pedidos de hoje — justamente os que interessam. Já quebrou uma vez
 * em 19/08. NÃO "corrigir".
 */
async function chamarNomos(cookie, dias) {
  const corpo = new URLSearchParams({
    dataInicio: dataBR(-(dias || 7)),
    dataFim: dataBR(1),
    horaInicio: '', horaFim: '', cliente: '',
    pedido_desconto: '', nfc_gerada: '', clienteRegistrado: '',
    numeroMesa: '', codigoPedidoDiario: '',
    flag_pedido_agendado: '', dataInicioAgendamento: '', dataFimAgendamento: '',
    numero_registros: '10000', ordenacao: '',
  });

  const r = await fetch(NOMOS + LISTAR, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: NOMOS + '/app/varanda/gestorpedido',
    },
    body: corpo.toString(),
    redirect: 'manual', // redirect = caiu no login = sessão expirada
  });

  const texto = await r.text();

  // Sessão expirada se: redirecionou, ou voltou HTML de login em vez de JSON.
  const redirecionou = r.status >= 300 && r.status < 400;
  const pareceLogin = /type=["']?password|name=["']?senha/i.test(texto);

  let json = null;
  try { json = JSON.parse(texto); } catch (_) { /* não é JSON */ }

  return { http: r.status, redirecionou, pareceLogin, json, tamanho: texto.length };
}

module.exports = async function handler(req, res) {
  const recebido = limpar((req.query && req.query.token) || req.headers['x-varanda-token']);
  const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean).map((t) => limpar(t));
  if (!recebido || !aceitos.includes(recebido)) {
    return responder(res, 401, { erro: 'Token inválido.' });
  }
  if (!supabaseConfigurado()) {
    return responder(res, 500, { erro: 'Supabase não configurado.' });
  }

  // ---------------------------------------------------------------- GUARDAR
  if (req.method === 'POST') {
    let corpo = req.body;
    if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch (_) { corpo = null; } }
    const bruto = limpar(corpo && corpo.cookie);

    if (!bruto) {
      return responder(res, 400, { erro: 'Campo "cookie" é obrigatório.' });
    }

    // Guarda só o par sisfood_session, não todo o document.cookie.
    const par = bruto.split(';').map((p) => p.trim())
      .find((p) => p.toLowerCase().startsWith('sisfood_session='));

    if (!par) {
      return responder(res, 400, {
        erro: 'Não achei sisfood_session no que foi enviado.',
        dica: 'Rode o comando com a aba do Nomos aberta e logada.',
      });
    }

    const g = await sb('/nomos_sessao', {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        id: 1, cookie: par, capturado_em: new Date().toISOString(),
        ultimo_status: null, ultimo_uso_em: null,
      }),
    });

    if (!g.ok) {
      return responder(res, 502, { erro: 'Falha ao gravar.', detalhe: g.corpo });
    }

    // Testa na hora: guardar sem testar é o erro que a gente já cometeu 3 vezes.
    const t = await chamarNomos(par, 1);
    const funcionou = !!(t.json && !t.redirecionou && !t.pareceLogin);

    await sb('/nomos_sessao?id=eq.1', {
      method: 'PATCH',
      body: JSON.stringify({
        ultimo_uso_em: new Date().toISOString(),
        ultimo_status: funcionou ? 'ok' : 'expirado',
      }),
    });

    return responder(res, 200, {
      guardado: true,
      tamanho_cookie: par.length,   // o TAMANHO, nunca o valor
      teste_imediato: funcionou ? 'FUNCIONOU — o servidor lê o Nomos sozinho' : 'NAO funcionou',
      http_nomos: t.http,
      caiu_no_login: t.pareceLogin || t.redirecionou,
    });
  }

  // ------------------------------------------------------------------ LER
  const q = await sb('/nomos_sessao?select=cookie,capturado_em,ultimo_uso_em,ultimo_status&id=eq.1');
  const linha = (q.ok && Array.isArray(q.corpo) && q.corpo[0]) ? q.corpo[0] : null;

  if (!linha) {
    return responder(res, 200, {
      tem_sessao: false,
      o_que_fazer: 'Rodar o comando de captura no console do navegador, com o Nomos aberto e logado.',
    });
  }

  const base = {
    tem_sessao: true,
    tamanho_cookie: linha.cookie.length,
    capturado_em: linha.capturado_em,
    ultimo_uso_em: linha.ultimo_uso_em,
    ultimo_status: linha.ultimo_status,
  };

  if (!(req.query && (req.query.teste === '1' || req.query.teste === 'true'))) {
    return responder(res, 200, base);
  }

  // ----------------------------------------------------------------- TESTAR
  const t = await chamarNomos(linha.cookie, 7);
  const funcionou = !!(t.json && !t.redirecionou && !t.pareceLogin);

  await sb('/nomos_sessao?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({
      ultimo_uso_em: new Date().toISOString(),
      ultimo_status: funcionou ? 'ok' : 'expirado',
    }),
  });

  if (!funcionou) {
    return responder(res, 200, Object.assign(base, {
      teste: 'FALHOU',
      http_nomos: t.http,
      caiu_no_login: t.pareceLogin || t.redirecionou,
      o_que_fazer: 'A sessão expirou. Capturar o cookie de novo com o Nomos aberto e logado.',
    }));
  }

  // Só a ESTRUTURA. Nenhum dado de cliente sai daqui.
  const j = t.json;
  const pedidos = Array.isArray(j.pedidos_json) ? j.pedidos_json : [];
  const produtos = Array.isArray(j.cardapio_produto_quantidade) ? j.cardapio_produto_quantidade : [];

  return responder(res, 200, Object.assign(base, {
    teste: 'FUNCIONOU — o servidor lê o Nomos sem navegador',
    http_nomos: t.http,
    estrutura: {
      pedidos: pedidos.length,
      colunas_por_pedido: pedidos[0] ? Object.keys(pedidos[0]).length : 0,
      produtos_vendidos: produtos.length,
      campos_do_produto: produtos[0] ? Object.keys(produtos[0]) : null,
      // nomes de produto NÃO são dado de cliente, e são o que valida o kg
      nomes_de_produto: produtos.map((p) => p.nome_produto).filter(Boolean).slice(0, 30),
      valor_total: j.valor_total,
      quantidade_pedido: j.quantidade_pedido,
      clientes_novos: j.clientes_novos,
      ticket_medio: j.ticket_medio,
      tipos_de_pedido: j.pedidos_tipo_quantidade || null,
      ifood: j.totais_ifood ? j.totais_ifood.valor_total_ifood : null,
      aiqfome: j.totais_aiqfome ? j.totais_aiqfome.valor_total_aiqfome : null,
      food99: j.totais_99food ? j.totais_99food.valor_total_99food : null,
    },
  }));
};
