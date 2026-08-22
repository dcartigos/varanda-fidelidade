// POST /api/enviar
//
// Único caminho pelo qual o sistema do Varanda manda mensagem no WhatsApp
// A PARTIR DE FORA (navegador, painel). O navegador NUNCA fala com a YCloud
// direto: navegador -> este endpoint -> YCloud -> Meta. A chave da API existe
// só no servidor, como variável de ambiente do Vercel.
//
// Este arquivo agora só cuida de DUAS coisas: validar o método/token de quem
// chamou por HTTP, e ler o corpo da requisição. Toda a lógica de envio (telefone,
// trava de horário, trava dos 13 dígitos, idempotência, chamada à YCloud,
// gravação em envios) mora em api/_lib/envio.js — a MESMA função é chamada
// diretamente (sem HTTP, sem token) por api/rotina-diaria.js e
// api/backfill-pontos.js. Não duplique essa lógica aqui.
//
// Corpo esperado (JSON):
// { "telefone": "999691829" | "44999691829" | "+5544999691829",
//   "texto": "mensagem livre",                        <- só funciona na janela de 24h
//   "chave": "5544999691829|2026-08-14|pontos",        <- idempotência (recomendado)
//   "forcar": false }                                  <- ignora a trava de horário
//
// ou, para template aprovado (fora da janela de 24h):
//   { "telefone": "...", "template": "saldo_pontos", "idioma": "pt_BR",
//     "parametros": ["José", "126"], "chave": "..." }
//
// Cabeçalho obrigatório: x-varanda-token: <APP_TOKEN>

const { enviarMensagem } = require('./_lib/envio');

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).send(JSON.stringify(corpo));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return responder(res, 405, { erro: 'Use POST.' });
  }

  // ---- Autenticação do nosso próprio painel -------------------------------
  // .trim() nos dois lados: um token colado no Vercel com espaço ou quebra de
  // linha à toa (acontece fácil ao copiar/colar) nunca mais deve derrubar a
  // comparação por um caractere invisível.
  const tokenEsperado = (process.env.APP_TOKEN || '').trim();
  const tokenRecebido = String(req.headers['x-varanda-token'] || '').trim();

  if (!tokenEsperado) {
    return responder(res, 500, {
      erro: 'APP_TOKEN não configurado no servidor.',
    });
  }
  if (!tokenRecebido || tokenRecebido !== tokenEsperado) {
    return responder(res, 401, { erro: 'Token inválido.' });
  }

  // ---- Leitura do corpo ---------------------------------------------------
  let corpo = req.body;
  if (typeof corpo === 'string') {
    try {
      corpo = JSON.parse(corpo);
    } catch (_) {
      return responder(res, 400, { erro: 'Corpo não é JSON válido.' });
    }
  }
  corpo = corpo || {};

  // ---- Envio (lógica compartilhada) ---------------------------------------
  const resultado = await enviarMensagem(corpo);
  const { httpStatus, ...resto } = resultado;
  return responder(res, httpStatus, resto);
};
