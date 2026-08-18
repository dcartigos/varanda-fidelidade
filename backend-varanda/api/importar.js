// POST /api/importar
//
// Recebe os pedidos raspados do Nomos e grava em 'nomos_pedidos'.
// Depois chama recalcular_base_clientes() para atualizar a fila de disparo.
//
// ⚠️ ATENÇÃO A UMA ARMADILHA DESTE BANCO (descoberta em 18/08/2026):
// existem tabelas 'visitas' e 'clientes' que NÃO são nossas — são do painel
// de fidelidade, com outro significado (clientes tem pontos_atual, visitas
// aponta para cliente_id uuid). Nunca escrever nelas por aqui.
// A tabela de pedidos é 'nomos_pedidos' (PK codigo) e a fila de disparo é
// 'base_clientes' (PK telefone_e164).
//
// Quem chama: o script coleta_nomos.js, rodando no navegador com a sessão do
// Nomos aberta. O Nomos não tem API — essa é a única porta de entrada.
//
// Corpo esperado:
//   { "pedidos": [
//       { "codigo":"22775", "tipo":"Mesa/Comanda", "valor":"R$ 24,96",
//         "data":"17/08 13:46", "cliente":"Eduardo | 99903-8433" },
//       ...
//     ],
//     "ano": 2026 }        <- o Nomos mostra "17/08" sem o ano
//
// Cabeçalho obrigatório: x-varanda-token: <APP_TOKEN>
//
// Idempotente de propósito: 'nomos_pedidos' tem PRIMARY KEY (codigo), então rodar
// duas vezes no mesmo dia não duplica nada. Isso é o que permite a rotina rodar
// sem medo e permite reimportar um período para corrigir uma falha.

const { normalizarTelefone } = require('./_lib/telefone');
const { supabaseConfigurado } = require('./_lib/supabase');

// ---------------------------------------------------------------------------
// CORS — por que isto existe
// ---------------------------------------------------------------------------
// O coletor roda DENTRO da página do Nomos (nomosmenu.com.br) e chama este
// endpoint, que está em varanda-backend.vercel.app. São origens diferentes, e
// o navegador bloqueia isso por padrão. Sem estes cabeçalhos o coletor recebe
// "Failed to fetch" e nunca chega a mandar nada.
//
// A lista é FECHADA de propósito. Não uso '*': se qualquer site pudesse chamar
// este endpoint, uma página maliciosa aberta no navegador do Lucas poderia
// gravar pedidos falsos usando o token guardado. Só as origens abaixo passam.
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-varanda-token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(corpo));
}

/** "R$ 1.234,56" -> 1234.56 · "" -> null */
function valorParaNumero(txt) {
  if (!txt) return null;
  const limpo = String(txt).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(limpo);
  return isNaN(n) ? null : n;
}

/**
 * O Nomos mostra "17/08 13:46" — sem ano. Se eu assumisse o ano atual sempre,
 * um pedido de 30/12 importado em janeiro viraria uma visita no futuro.
 * Então: se a data ficar mais de 2 dias à frente de hoje, é do ano anterior.
 */
function dataParaISO(txt, anoBase) {
  if (!txt) return null;
  const m = String(txt).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?[ ,]*(\d{1,2}):(\d{2})?/);
  if (!m) return null;

  const dia = +m[1];
  const mes = +m[2];
  let ano = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : anoBase;
  const hora = +m[4] || 0;
  const min = +m[5] || 0;

  // -03:00 fixo. O Brasil não tem horário de verão desde 2019.
  let iso = new Date(Date.UTC(ano, mes - 1, dia, hora + 3, min));
  if (!m[3] && iso.getTime() - Date.now() > 2 * 86400000) {
    iso = new Date(Date.UTC(ano - 1, mes - 1, dia, hora + 3, min));
  }
  return isNaN(iso.getTime()) ? null : iso.toISOString();
}

/**
 * A célula "Cliente/Telefone" do Nomos vem em vários formatos:
 *   ""                        -> Mesa/Comanda que o caixa não identificou
 *   "Eduardo | 99903-8433"    -> nome e telefone
 *   "0800 123 4567"           -> iFood, telefone MASCARADO (inútil)
 * Devolve sempre {nome, e164, valido}.
 */
function lerCliente(txt) {
  const bruto = String(txt || '').replace(/\s+/g, ' ').trim();
  if (!bruto) return { nome: null, e164: null, valido: false };

  const partes = bruto.split('|').map((s) => s.trim());
  let nome = null;
  let candidato = null;

  for (const p of partes) {
    const digitos = p.replace(/\D/g, '');
    if (digitos.length >= 8) candidato = p;
    else if (p && !nome) nome = p;
  }
  if (!candidato && partes.length === 1) {
    const d = bruto.replace(/\D/g, '');
    if (d.length >= 8) candidato = bruto;
    else nome = bruto;
  }
  if (!candidato) return { nome: nome || null, e164: null, valido: false };

  // Os 0800 do iFood são mascarados por pedido. Nunca são WhatsApp.
  const dig = candidato.replace(/\D/g, '');
  if (/^0?800/.test(dig)) return { nome: nome || null, e164: null, valido: false };

  const tel = normalizarTelefone(candidato);
  if (!tel.ok) return { nome: nome || null, e164: null, valido: false };
  return { nome: nome || null, e164: tel.e164, valido: true };
}

async function supabase(caminho, opcoes) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(url + '/rest/v1' + caminho, {
    ...opcoes,
    headers: {
      apikey: chave,
      Authorization: 'Bearer ' + chave,
      'Content-Type': 'application/json',
      ...(opcoes && opcoes.headers),
    },
  });
  const texto = await r.text();
  return { ok: r.ok, status: r.status, corpo: texto ? JSON.parse(texto) : null };
}

module.exports = async function handler(req, res) {
  aplicarCors(req, res);

  // Antes do POST real, o navegador manda um OPTIONS ("preflight") perguntando
  // se pode. Se responder 405 aqui, o POST nunca acontece.
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') return responder(res, 405, { erro: 'Use POST.' });

  // ---- Autenticação -------------------------------------------------------
  // Este endpoint aceita DOIS tokens, e isso é de propósito:
  //
  //   IMPORT_TOKEN  -> token estreito, só serve para importar pedidos.
  //                    É ele que fica no localStorage do nomosmenu.com.br.
  //                    Se vazar, o pior que acontece é alguém gravar pedidos.
  //   APP_TOKEN     -> token do painel, abre também o /api/enviar (manda
  //                    WhatsApp em nome do Varanda). Aceito aqui só por
  //                    conveniência de teste. NUNCA deve ir para o navegador
  //                    de um site de terceiro.
  //
  // A separação existe porque o token que vive num site que não é nosso tem
  // que ser o de menor poder possível.
  const recebido = req.headers['x-varanda-token'];
  const aceitos = [process.env.IMPORT_TOKEN, process.env.APP_TOKEN].filter(Boolean);

  if (aceitos.length === 0) {
    return responder(res, 500, {
      erro: 'Nem IMPORT_TOKEN nem APP_TOKEN configurados no servidor.',
    });
  }
  if (!recebido || !aceitos.includes(recebido)) {
    return responder(res, 401, { erro: 'Token inválido.' });
  }
  if (!supabaseConfigurado()) {
    return responder(res, 500, { erro: 'Supabase não configurado.' });
  }

  let corpo = req.body;
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); } catch (_) {
      return responder(res, 400, { erro: 'Corpo não é JSON válido.' });
    }
  }
  const pedidos = (corpo && corpo.pedidos) || [];
  const anoBase = (corpo && corpo.ano) || new Date().getFullYear();

  if (!Array.isArray(pedidos) || pedidos.length === 0) {
    return responder(res, 400, { erro: 'Campo "pedidos" vazio.' });
  }

  // ---- TRAVA: volume absurdo indica raspagem quebrada, não dia movimentado --
  if (pedidos.length > 12000) {
    return responder(res, 400, {
      erro: 'Mais de 12.000 pedidos num lote. Provavelmente a raspagem quebrou.',
    });
  }

  // ---- Conversão ----------------------------------------------------------
  const linhas = [];
  const problemas = [];
  let semTelefone = 0;
  let mascarado = 0;

  for (const p of pedidos) {
    const codigo = String((p && p.codigo) || '').trim();
    const quando = dataParaISO(p && p.data, anoBase);

    if (!codigo) { problemas.push('pedido sem código'); continue; }
    if (!quando) { problemas.push('pedido ' + codigo + ' com data ilegível: ' + p.data); continue; }

    const c = lerCliente(p && p.cliente);
    if (!c.e164) {
      if (/0?800/.test(String(p && p.cliente || '').replace(/\D/g, ''))) mascarado++;
      else semTelefone++;
    }

    // Colunas da tabela 'nomos_pedidos', que JÁ EXISTIA no banco com 194
    // pedidos reais e PRIMARY KEY (codigo). Guardamos o telefone cru E o
    // normalizado: o cru para nunca perder a informação original do Nomos,
    // o normalizado para poder cruzar e disparar.
    linhas.push({
      codigo: Number(codigo),
      data_hora_pedido: quando,
      tipo: (p && p.tipo) || null,
      nome_cliente: c.nome,
      telefone: (p && p.cliente) ? String(p.cliente).replace(/\s+/g, ' ').trim() : null,
      telefone_e164: c.e164,
      telefone_valido: c.valido,
      valor: valorParaNumero(p && p.valor),
    });
  }

  if (linhas.length === 0) {
    return responder(res, 400, { erro: 'Nenhuma linha aproveitável.', problemas: problemas.slice(0, 20) });
  }

  // ---- Gravação em lotes ---------------------------------------------------
  // on_conflict=pedido_codigo + ignore-duplicates: reimportar é seguro.
  let gravados = 0;
  const LOTE = 500;
  for (let i = 0; i < linhas.length; i += LOTE) {
    const fatia = linhas.slice(i, i + LOTE);
    const r = await supabase('/nomos_pedidos?on_conflict=codigo', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify(fatia),
    });
    if (!r.ok) {
      return responder(res, 502, {
        erro: 'Falha ao gravar pedidos no Supabase.',
        detalhe: r.corpo,
        gravados_antes_da_falha: gravados,
      });
    }
    gravados += Array.isArray(r.corpo) ? r.corpo.length : 0;
  }

  // ---- Recalcula o resumo por telefone ------------------------------------
  const rec = await supabase('/rpc/recalcular_base_clientes', { method: 'POST', body: '{}' });

  const identificados = linhas.filter((l) => !!l.telefone_e164).length;

  return responder(res, 200, {
    ok: true,
    recebidos: pedidos.length,
    aproveitados: linhas.length,
    novos_gravados: gravados,
    ja_existiam: linhas.length - gravados,
    identificados,
    pct_identificados: Math.round((identificados / linhas.length) * 100),
    sem_telefone: semTelefone,
    telefone_mascarado_ifood: mascarado,
    clientes_recalculados: rec.ok ? rec.corpo : null,
    problemas: problemas.slice(0, 20),
    aviso: problemas.length > 20 ? problemas.length + ' problemas no total' : null,
  });
};
