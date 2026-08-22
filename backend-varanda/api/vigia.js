// GET /api/vigia?token=...
//
// O VIGIA: avisa o Lucas quando as rotinas do dia NÃO rodaram.
//
// POR QUE ESTE ENDPOINT EXISTE
// Em 20/08/2026 as duas rotinas do PC do Varanda falharam e ninguém soube.
// A rotina de pontos parou por falta de token; a de fechamento nunca chegou a
// chamar /api/enviar. O único "sinal" de erro era a AUSÊNCIA de linha no log —
// e ausência não avisa ninguém. O Lucas descobriu perguntando.
//
// A lição: um sistema que só reporta sucesso não é monitorado. Precisa existir
// algo que reclame do silêncio. É este arquivo.
//
// COMO USAR
// Vercel Cron (vercel.json), uma vez por dia:
//   { "crons": [{ "path": "/api/vigia?token=SEU_IMPORT_TOKEN", "schedule": "0 19 * * 1-6" }] }
// 19:00 UTC = 16:00 em Brasília — depois de todas as rotinas e antes de o
// restaurante fechar de vez. No plano Hobby a precisão é de ±59min, o que é
// suficiente: o objetivo é avisar no mesmo dia, não no minuto exato.
//
// Também pode ser chamado na mão, pelo navegador, para conferir o dia.

const { supabaseConfigurado } = require('./_lib/supabase');

const LUCAS = '+5544999691829';

function responder(res, status, corpo) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(status).send(JSON.stringify(corpo, null, 1));
}

async function sb(caminho) {
      const url = process.env.SUPABASE_URL;
      const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const r = await fetch(url + '/rest/v1' + caminho, {
              headers: { apikey: chave, Authorization: 'Bearer ' + chave, 'Content-Type': 'application/json' },
      });
      const txt = await r.text();
      return { ok: r.ok, corpo: txt ? JSON.parse(txt) : null };
}

/** Manda o alerta pelo nosso próprio /api/enviar, em texto livre. */
async function alertar(texto) {
      const base = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '';
      const r = await fetch(base + '/api/enviar', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-varanda-token': String(process.env.APP_TOKEN || '').trim() },
              body: JSON.stringify({
                        telefone: LUCAS,
                        texto,
                        chave: 'vigia|' + LUCAS + '|' + new Date().toISOString().slice(0, 10),
                        forcar: true,
              }),
      });
      return { status: r.status, corpo: await r.text() };
}

module.exports = async function handler(req, res) {
      // Autenticação: o Vercel Cron manda o header 'x-vercel-cron'. Chamada manual
      // precisa de token. Assim o cron funciona sem colocar segredo na URL.
      const doCron = !!req.headers['x-vercel-cron'];
      const recebido = String((req.query && req.query.token) || req.headers['x-varanda-token'] || '').trim();
      const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN].filter(Boolean).map((t) => String(t).trim());
      if (!doCron && (!recebido || !aceitos.includes(recebido))) {
              return responder(res, 401, { erro: 'Token inválido.' });
      }
      if (!supabaseConfigurado()) {
              return responder(res, 500, { erro: 'Supabase não configurado.' });
      }

      const agoraBR = new Date(Date.now() - 3 * 3600 * 1000);
      const hoje = agoraBR.toISOString().slice(0, 10);
      const desde = hoje + 'T00:00:00-03:00';

      // Domingo o restaurante não abre. Vigiar domingo geraria alerta falso toda
      // semana, e alerta falso treina a pessoa a ignorar alerta de verdade.
      if (agoraBR.getUTCDay() === 0) {
              return responder(res, 200, { dia: hoje, domingo: true, aviso: 'domingo, nada a vigiar' });
      }

      // 1. A coleta do Nomos rodou? (pedidos de hoje no banco)
      const pedidos = await sb(
              '/nomos_pedidos?select=codigo&data_hora_pedido=gte.' + encodeURIComponent(desde) + '&limit=1'
            );
      const coletou = pedidos.ok && Array.isArray(pedidos.corpo) && pedidos.corpo.length > 0;

      // 2. Saíram mensagens de pontos hoje?
      const env = await sb(
              '/envios?select=telefone_e164,template,criado_em&criado_em=gte.' +
              encodeURIComponent(desde) + '&limit=500'
            );
      const envios = (env.ok && Array.isArray(env.corpo)) ? env.corpo : [];
      const pontos = envios.filter((e) => e.template === 'atualizacao_cadastro_pontos').length;
      const relatorio = envios.filter((e) => !e.template).length; // texto livre = fechamento

      // 3. Alguma coisa ficou presa em 'sent' sem resolver?
      const st = await sb(
              '/status_mensagens?select=telefone_e164,status&registrado_em=gte.' +
              encodeURIComponent(desde) + '&limit=2000'
            );
      const eventos = (st.ok && Array.isArray(st.corpo)) ? st.corpo : [];
      const ultimo = {};
      for (const e of eventos) ultimo[e.telefone_e164] = e.status;
      const presos = Object.entries(ultimo).filter(([, s]) => s === 'sent').map(([t]) => t);

      const problemas = [];
      if (!coletou) problemas.push('a coleta do Nomos NAO rodou (nenhum pedido de hoje no banco)');
      if (pontos === 0) problemas.push('a rotina de PONTOS das 14h15 nao enviou nada');
      if (relatorio === 0) problemas.push('a rotina de FECHAMENTO das 14h30 nao enviou nada');
      if (presos.length >= 3) problemas.push(presos.length + ' mensagens presas em "sent" (nao entregues)');

      const resumo = {
              dia: hoje,
              coleta_nomos_rodou: coletou,
              pontos_enviados: pontos,
              relatorios_enviados: relatorio,
              presos_em_sent: presos.length,
              problemas,
              alerta_enviado: false,
      };

      if (problemas.length === 0) return responder(res, 200, resumo);

      // Só avisa se houver problema. Alerta que chega todo dia vira ruído e é ignorado.
      const texto =
              '*VARANDA — aviso automático ' + hoje.split('-').reverse().join('/') + '*\n\n' +
              'As rotinas de hoje não fecharam:\n\n' +
              problemas.map((p) => '• ' + p).join('\n') +
              '\n\n_Isto é o vigia. Ele só escreve quando algo falha._';

      try {
              const r = await alertar(texto);
              resumo.alerta_enviado = r.status === 200;
              resumo.alerta_resposta = r.status;
      } catch (e) {
              resumo.alerta_erro = e.message;
      }

      return responder(res, 200, resumo);
};
