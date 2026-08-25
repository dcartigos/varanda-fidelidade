// GET /api/status?minutos=15
//
// Devolve o status REAL das mensagens enviadas nos últimos N minutos, lido da
// tabela status_mensagens (que é alimentada pelo webhook da Meta).
//
// POR QUE ESTE ENDPOINT EXISTE
// A resposta 200 "aceito" do /api/enviar NÃO significa entregue — significa só
// que a Meta pegou na fila. A verdade chega depois, pelo webhook. Esse engano já
// foi cometido duas vezes neste projeto (14/08 e 19/08), nas duas o relatório
// dizia "enviado" e as mensagens tinham falhado.
//
// Antes deste endpoint, a rotina do PC do Varanda precisava de LOGIN NO SUPABASE
// para conferir isso. Isso significava: um login a mais para manter, e um
// navegador com acesso de leitura ao banco inteiro numa máquina compartilhada.
// Com este endpoint, a rotina só precisa do Nomos e do nosso próprio backend.
//
// Aceita IMPORT_TOKEN ou APP_TOKEN: é leitura, e só devolve contagem agregada
// mais os telefones que falharam (para poder marcar quem não tem WhatsApp).

const { supabaseConfigurado } = require('./_lib/supabase');

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
  res.status(status).send(JSON.stringify(corpo));
}

/** O que cada código de erro significa, em português, para quem não é técnico. */
const EXPLICACAO = {
  131047: 'janela de 24h fechada — a pessoa precisa mandar uma mensagem para o 2090 primeiro',
  131026: 'número não tem WhatsApp — marcar como sem_whatsapp e parar de tentar',
  133010: 'ATENCAO: a conexão do número caiu (Coexistence) — reconectar na YCloud',
  132000: 'número de parâmetros do template não bate com o aprovado',
  131049: 'a Meta limitou a entrega para preservar a experiência do usuário',
  130472: 'a pessoa está num experimento da Meta e não recebe marketing agora',
};

async function supabase(caminho) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(url + '/rest/v1' + caminho, {
    headers: {
      apikey: chave,
      Authorization: 'Bearer ' + chave,
      'Content-Type': 'application/json',
    },
  });
  const texto = await r.text();
  return { ok: r.ok, status: r.status, corpo: texto ? JSON.parse(texto) : null };
}

module.exports = async function handler(req, res) {
  aplicarCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') return responder(res, 405, { erro: 'Use GET.' });

  const recebido = req.headers['x-varanda-token'];
  const aceitos = [process.env.IMPORT_TOKEN, process.env.APP_TOKEN].filter(Boolean);
  if (aceitos.length === 0) {
    return responder(res, 500, { erro: 'Nenhum token configurado no servidor.' });
  }
  if (!recebido || !aceitos.includes(recebido)) {
    return responder(res, 401, { erro: 'Token inválido.' });
  }
  if (!supabaseConfigurado()) {
    return responder(res, 500, { erro: 'Supabase não configurado.' });
  }

  // Janela de tempo: padrão 15 min, teto de 24h para não puxar a tabela toda.
  let minutos = parseInt(req.query && req.query.minutos, 10);
  if (!minutos || minutos < 1) minutos = 15;
  if (minutos > 1440) minutos = 1440;

  const desde = new Date(Date.now() - minutos * 60000).toISOString();

  const r = await supabase(
    '/status_mensagens?select=telefone_e164,status,erro_codigo,categoria_preco,registrado_em' +
    '&registrado_em=gte.' + encodeURIComponent(desde) +
    '&order=registrado_em.desc&limit=2000'
  );
  if (!r.ok) {
    return responder(res, 502, { erro: 'Falha ao ler o Supabase.', detalhe: r.corpo });
  }

  // Só o ÚLTIMO status de cada telefone conta. Uma mensagem passa por
  // sent -> delivered -> read; contar tudo inflaria os números.
  const ultimo = {};
  for (const linha of r.corpo || []) {
    if (!ultimo[linha.telefone_e164]) ultimo[linha.telefone_e164] = linha;
  }

  const porStatus = {};
  const falhas = [];
  const precos = {};

  for (const l of Object.values(ultimo)) {
    porStatus[l.status] = (porStatus[l.status] || 0) + 1;
    if (l.categoria_preco) precos[l.categoria_preco] = (precos[l.categoria_preco] || 0) + 1;
    if (l.status === 'failed') {
      falhas.push({
        telefone: l.telefone_e164,
        erro: l.erro_codigo,
        significa: EXPLICACAO[l.erro_codigo] || 'código não catalogado — pesquisar na doc da Meta',
      });
    }
  }

  const entregues = (porStatus.delivered || 0) + (porStatus.read || 0);
  const total = Object.keys(ultimo).length;

  // sem_whatsapp: telefones que devem ser marcados para nunca mais tentar
  const semWhatsapp = falhas.filter((f) => f.erro === 131026).map((f) => f.telefone);
  const janelaFechada = falhas.filter((f) => f.erro === 131047).map((f) => f.telefone);
  const conexaoCaiu = falhas.some((f) => f.erro === 133010);

  return responder(res, 200, {
    janela_minutos: minutos,
    total_mensagens: total,
    entregues,
    em_transito: porStatus.sent || 0,
    falharam: porStatus.failed || 0,
    por_status: porStatus,
    por_categoria_preco: precos,
    falhas,
    sem_whatsapp: semWhatsapp,
    janela_24h_fechada: janelaFechada,
    alerta_conexao_caiu: conexaoCaiu,
    aviso: conexaoCaiu
      ? 'ERRO 133010 DETECTADO: a conexão do número 2090 caiu. Nada mais vai ser entregue até reconectar na YCloud.'
      : null,
  });
};
