// GET /api/disparar-robo
//
// POR QUE ESTE ARQUIVO EXISTE (13/11/2026)
// ===========================================================================
// O relatorio nunca chegava no horario. A causa nao era o cron da Vercel nem
// o codigo: era o AGENDADOR DO GITHUB. Os registros do proprio GitHub, do dia
// 12/11, nao deixam duvida — o robo estava agendado para 14h07, 14h27, 14h47
// e 15h17, e as quatro execucoes sairam as 19h41, 19h46, 19h51 e 20h41. No
// dia 13/11 nenhuma execucao agendada rodou ate as 14h50.
//
// Agendamento gratuito do GitHub e "melhor esforco": ele enfileira e roda
// quando sobra maquina. Nao existe ajuste de cron que conserte isso.
//
// O cron da Vercel e pontual: nos registros ele dispara 18:00:45 todo santo
// dia, com menos de um segundo de variacao. Entao invertemos quem manda:
//
//   ANTES:  GitHub decide a hora -> robo coleta -> relatorio sai 20h30
//   AGORA:  Vercel decide a hora -> manda o GitHub rodar JA -> 14h30
//
// Execucao disparada por API comeca em segundos: nao entra na fila do
// agendador. Foi assim que as execucoes manuais de hoje comecaram na hora.
//
// PRECISA DE: GITHUB_TOKEN no Vercel (fine-grained, so este repositorio,
// permissao Actions = Read and write). Sem ele este endpoint nao quebra nada:
// responde dizendo o que falta, e o dia segue como antes.

const REPO = 'dcartigos/varanda-fidelidade';
const WORKFLOW = 'coleta-nomos.yml';

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
}

module.exports = async function handler(req, res) {
  const doCron = !!req.headers['x-vercel-cron'];
  const recebido = String((req.query && req.query.token) || req.headers['x-varanda-token'] || '').trim();
  const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean).map((t) => String(t).trim());
  if (!doCron && (!recebido || !aceitos.includes(recebido))) {
    return responder(res, 401, { erro: 'Token invalido.' });
  }

  const agoraBR = new Date(Date.now() - 3 * 3600 * 1000);
  if (agoraBR.getUTCDay() === 0) {
    return responder(res, 200, { domingo: true, aviso: 'domingo, nao disparei nada' });
  }

  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    return responder(res, 503, {
      erro: 'GITHUB_TOKEN nao configurado no Vercel.',
      o_que_fazer: 'Vercel > Settings > Environment Variables > GITHUB_TOKEN. Token ' +
        'fine-grained do GitHub, so neste repositorio, permissao Actions = Read and write.',
      enquanto_isso: 'O robo continua dependendo do agendador do GitHub, que atrasa.',
    });
  }

  const url = 'https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'varanda-backend',
      },
      body: JSON.stringify({ ref: 'main' }),
    });

    if (r.status === 204) {
      return responder(res, 200, {
        disparado: true,
        quando: agoraBR.toISOString().slice(0, 16).replace('T', ' ') + ' (Brasilia)',
        proximo_passo: 'O robo leva ~5 min. Ao terminar ele mesmo chama a rotina-diaria.',
      });
    }

    const texto = await r.text().catch(() => '');
    return responder(res, 502, {
      disparado: false,
      status: r.status,
      // Nunca devolvemos o token, nem pedaco dele. So o que o GitHub reclamou.
      detalhe: texto.slice(0, 300),
      dica: (r.status === 401 || r.status === 403)
        ? 'Token invalido, expirado ou sem a permissao Actions (Read and write).'
        : 'Ver a resposta do GitHub acima.',
    });
  } catch (e) {
    return responder(res, 502, { disparado: false, erro: 'falha de rede: ' + e.message });
  }
};
