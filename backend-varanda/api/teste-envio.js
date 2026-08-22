// GET /api/teste-envio?telefone=+5544999691829&token=...
//
// Endpoint de teste manual: manda UMA mensagem real usando a MESMA função
// enviarMensagem() de api/_lib/envio.js que rotina-diaria.js e
// backfill-pontos.js usam internamente. Existe para testar o caminho real
// de ponta a ponta (telefone -> YCloud -> Meta -> webhook) sem depender de
// um cliente de verdade ter feito pedido hoje.
//
// Criado em 22/08/2026, junto com a extração de api/_lib/envio.js — o
// teste seco=1 de rotina-diaria.js e backfill-pontos.js NUNCA chega a
// chamar enviarMensagem(), então nunca teria pego o bug do self-fetch
// de 21/08. Este endpoint é o teste que faltava.
//
// Manda o mesmo template usado para pontos de fidelidade (atualizacao_
// cadastro_pontos), com valores de teste óbvios, para não ser confundido
// com uma mensagem de saldo real.

const { enviarMensagem } = require('./_lib/envio');

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
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

  const telefone = req.query && req.query.telefone;
  if (!telefone) {
    return responder(res, 400, { erro: 'Parâmetro telefone=+55DDDXXXXXXXXX é obrigatório.' });
  }

  const agora = new Date();
  const chave = 'teste|' + telefone + '|' + agora.toISOString();

  const r = await enviarMensagem({
    telefone,
    template: 'atualizacao_cadastro_pontos',
    idioma: 'pt_BR',
    parametros: ['TESTE', agora.toLocaleDateString('pt-BR'), '0'],
    chave,
    forcar: true,
  });

  return responder(res, r.httpStatus || 200, r);
};
