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
//   1. o token nunca foi colado no PC do Varanda   -> 20/08, nada saiu
//   2. o token foi rotacionado e o valor se perdeu -> era Sensitive no Vercel
//   3. o navegador do PC estava com localStorage vazio
//   4. o classificador de segurança do assistente bloqueou ler o token
//
// Nenhuma dessas é um bug de código. Todas são consequência da MESMA decisão de
// arquitetura errada: **pedir para o cliente guardar um segredo**.
//
// A correção é inverter os papéis:
//
//   ANTES:  o PC lê o Nomos, monta a mensagem e ENVIA (precisa do token)
//   AGORA:  o PC lê o Nomos e só GRAVA os números.  O SERVIDOR envia.
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

const { supabaseConfigurado } = require('./_lib/supabase');
const { enviarTelegram } = require('./telegram');

const EQUIPE = [
  { nome: 'Lucas',    telefone: '+5544999691829', completo: true },
  { nome: 'Leopoldo', telefone: '+5524999410719', completo: true },
  { nome: 'Maria',    telefone: '+5544997335705', completo: false }, // só clientes
];

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
              'quinta-feira', 'sexta-feira', 'sábado'];

function responder(res, status, corpo) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(corpo, null, 1));
}

// ---------------------------------------------------------------------------
// CORS — adicionado em 25/08/2026.
//
// Esta rotina nasceu para ser chamada pelo cron da Vercel, que não é navegador
// e não precisa de CORS. Mas o Coletor (PC do Varanda) chama a partir da página
// do Nomos para a conferência com &seco=1 — e sem estes cabeçalhos o navegador
// bloqueia a LEITURA da resposta e mostra "Failed to fetch", igualzinho a
// servidor fora do ar. Foi exatamente o que travou o passo 7 em 25/08.
//
// Regra do projeto a partir de hoje: todo endpoint que o navegador chama usa
// este mesmo bloco, e o teste pós-deploy inclui uma chamada da origem real.
// ---------------------------------------------------------------------------
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

/** Chama o nosso próprio /api/enviar. O token vem do ambiente, não do cliente. */
async function enviar(payload) {
  const base = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '';
  const r = await fetch(base + '/api/enviar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // .trim() de propósito: espaço invisível na variável de ambiente gerou
      // 401 por três dias, inclusive em chamada do servidor para si mesmo.
      'x-varanda-token': String(process.env.APP_TOKEN || '').trim(),
    },
    body: JSON.stringify(payload),
  });
  const corpo = await r.json().catch(() => ({}));
  return { status: r.status, aceito: !!corpo.aceito, erro: corpo.erro || corpo.motivo || null };
}

module.exports = async function handler(req, res) {
  aplicarCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Autenticação em três caminhos, do mais automático para o mais manual:
  //
  //  1. Vercel Cron  -> manda o header 'x-vercel-cron'. Não precisa de token.
  //     É assim que roda todo dia. Ninguém digita nada.
  //
  //  2. TESTE_TOKEN  -> uma senha simples que o Lucas inventa e guarda, só para
  //     poder abrir a URL no navegador e conferir. Existe porque o APP_TOKEN é
  //     Sensitive no Vercel: nem o dono consegue ler o valor de volta, e ficar
  //     rotacionando segredo para poder testar foi o que travou 21/08.
  //
  //  3. APP_TOKEN / IMPORT_TOKEN -> continuam valendo, para quem tiver o valor.
  //
  //  ⚠️ CORRIGIDO EM 22/09/2026 — O MESMO BUG QUE MATOU A CAMPANHA EM 26/08.
  //  A linha aqui era `!!req.headers['x-vercel-cron']`. A Vercel NÃO manda
  //  esse cabeçalho. Ela se identifica pelo User-Agent 'vercel-cron/1.0'.
  //  Resultado: todo dia às 15h a Vercel chamava, levava 401 e ia embora em
  //  silêncio. Esta rotina NUNCA rodou sozinha -- só rodava quando alguem
  //  chamava na mao com token, de dentro do fluxo do COLETOR. Por isso ela
  //  parou junto com o coletor em 14/09.
  //  O cabecalho antigo continua aceito: se um dia a Vercel passar a mandar,
  //  funciona. Tirar seria trocar um caminho quebrado por outro.
  const ua = String(req.headers['user-agent'] || '');
  const ehUACron = /^vercel-cron\//i.test(ua);
  // Janela de horario no caminho do User-Agent: o cron e 15h (plano Hobby tem
  // precisao de ate 59min). Aceita das 14h as 18h e nada fora disso, para que
  // um User-Agent forjado nao consiga rodar a rotina de madrugada.
  const horaBR = new Date(Date.now() - 3 * 3600 * 1000).getUTCHours();
  const segredoCron = process.env.CRON_SECRET;
  const porSegredo = Boolean(segredoCron)
    && String(req.headers.authorization || '') === 'Bearer ' + segredoCron;
  const doCron = !!req.headers['x-vercel-cron']
    || porSegredo
    || (ehUACron && horaBR >= 14 && horaBR < 18);
  const recebido = String((req.query && req.query.token) || req.headers['x-varanda-token'] || '').trim();
  const aceitos = [process.env.TESTE_TOKEN, process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean).map((t) => String(t).trim());
  if (!doCron && (!recebido || !aceitos.includes(recebido))) {
    return responder(res, 401, {
      erro: 'Token inválido.',
      dica: 'Use ?token=SEU_TESTE_TOKEN (a variável TESTE_TOKEN do Vercel).',
      // Diagnostico sem vazar segredo: diz o que chegou, nao o que era esperado.
      visto: { user_agent: ua.slice(0, 40), hora_br: horaBR,
        tem_authorization: Boolean(req.headers.authorization) },
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

  // 24/09/2026 -- UMA VEZ POR DIA. O relatorio da equipe vai por Telegram, que
  // nao tem chave de idempotencia. Se a rotina rodar duas vezes (cron das 15h
  // + robo atrasado, por exemplo) o fechamento chegaria duas vezes. Agora a
  // rotina grava em execucoes_log quando envia, e recusa a segunda rodada do
  // dia. ?forcar=1 passa por cima -- e o que se usa para REENVIAR corrigido.
  const forcarRotina = req.query && (req.query.forcar === '1' || req.query.forcar === 'true');
  if (!seco && !forcarRotina) {
    const jaFoi = await sb('/execucoes_log?select=id,iniciado_em&rotina=eq.rotina-diaria&sucesso=is.true'
      + '&iniciado_em=gte.' + encodeURIComponent(hoje + 'T00:00:00-03:00') + '&limit=1');
    if (jaFoi.ok && Array.isArray(jaFoi.corpo) && jaFoi.corpo.length) {
      return responder(res, 200, {
        dia: hoje, ja_enviado_hoje: true, quando: jaFoi.corpo[0].iniciado_em,
        aviso: 'A rotina de hoje ja enviou pontos e fechamento. Nada foi feito. Para reenviar (ex.: numero corrigido), use &forcar=1.',
      });
    }
  }

  // =========================================================================
  // TRAVA DO CONTRATO DE COLETA — adicionada em 24/08/2026
  // =========================================================================
  //
  // POR QUE ESTA TRAVA EXISTE
  // Em 22/08 este relatório saiu para o Lucas, o Leopoldo e a Maria com TUDO
  // ZERADO: R$ 0,00, 0 pedidos, 0 novos cadastros. Não foi erro de cálculo — o
  // Coletor não havia rodado, o banco estava vazio, e o código somou zero com
  // zero e mandou. Parecia um dia sem movimento.
  //
  // O defeito de fundo: não havia como distinguir "o dia foi fraco" de
  // "ninguém coletou os dados". No banco as duas coisas são idênticas.
  //
  // `coleta_confiavel()` é essa distinção: só devolve true se o Coletor
  // declarou a coleta completa E havia pedidos do dia.
  //
  // REGRA: ausência de dado não é zero.
  const conf = await sb('/rpc/coleta_confiavel', {
    method: 'POST', body: JSON.stringify({ p_dia: hoje }),
  });
  const coletaOk = conf.ok && (conf.corpo === true || conf.corpo === 'true');

  resultado.coleta_confiavel = coletaOk;

  if (!coletaOk) {
    resultado.bloqueado = true;
    resultado.motivo =
      'O Coletor não declarou a coleta de hoje como completa. Nada foi enviado. ' +
      'Enviar agora significaria mandar número possivelmente zerado para os ' +
      'gestores e saldo possivelmente errado para os clientes.';
    resultado.o_que_fazer =
      'Conferir no PC do Varanda se o Coletor das 14h15 rodou. Depois de ele ' +
      'concluir, chamar esta URL de novo — a idempotência impede duplicidade.';

    // Registra a recusa: recusa silenciosa seria o mesmo defeito de antes.
    await sb('/execucoes_log', {
      method: 'POST',
      body: JSON.stringify({
        rotina: 'rotina-diaria',
        sucesso: false,
        terminado_em: new Date().toISOString(),
        mensagem: 'bloqueado: coleta_confiavel() = false',
      }),
    });

    // 22/09/2026 -- E AVISA NO TELEGRAM.
    // Gravar numa tabela que ninguem abre E uma recusa silenciosa. De 15 a
    // 22/09 esta rotina se bloqueou todo dia e ninguem soube: o Lucas so
    // descobriu 8 dias depois, perguntando. Uma rotina que se recusa a rodar
    // tem a obrigacao de dizer isso para uma pessoa, no mesmo dia.
    // Se o aviso falhar, nao muda nada: o bloqueio ja aconteceu e esta certo.
    try {
      await enviarTelegram(
        'VARANDA - ROTINA DAS 15h BLOQUEADA (' + hojeBR + ')\n\n'
        + 'Nao mandei pontos para cliente nenhum, nem o relatorio de '
        + 'fechamento. Motivo: o Coletor nao declarou a coleta de hoje como '
        + 'completa, entao os numeros do dia nao existem ou nao sao confiaveis.\n\n'
        + 'Isso NAO e um erro do servidor -- e a trava funcionando. Enviar '
        + 'agora seria mandar saldo errado para cliente.\n\n'
        + 'O QUE FAZER: rodar o Coletor no PC do Varanda. Assim que ele '
        + 'terminar, abrir /api/rotina-diaria de novo (a idempotencia impede '
        + 'envio duplicado).'
      );
    } catch (e) { /* o aviso e acessorio, nunca derruba a rotina */ }

    return responder(res, 200, resultado);
  }

  // =========================================================================
  // PARTE 1 — PONTOS para quem veio hoje
  // =========================================================================
  //
  // Depende de base_clientes.saldo_pontos, que o PC do Varanda grava ao ler o
  // relatório de fidelidade do Nomos. Sem isso, esta parte é pulada com aviso —
  // NUNCA inventar saldo.

  const doDia = await sb(
    '/nomos_pedidos?select=codigo,telefone_e164,data_hora_pedido' +
    '&data_hora_pedido=gte.' + encodeURIComponent(hoje + 'T00:00:00-03:00') +
    '&telefone_valido=is.true&order=data_hora_pedido.desc&limit=500'
  );
  const pedidosHoje = (doDia.ok && Array.isArray(doDia.corpo)) ? doDia.corpo : [];

  // último pedido de cada telefone, só 13 dígitos
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
    // ⚠️ BUG CORRIGIDO EM 25/08/2026 — o encodeURIComponent aqui é OBRIGATÓRIO.
    // Sem ele, o "+" do +5544... vira ESPAÇO na URL e o banco procura " 5544...":
    // zero encontrados. Resultado: com_saldo=0 E sem_saldo_no_banco=0 ao mesmo
    // tempo — a assinatura deste bug. A gravação no coleta.js sempre codificou;
    // só esta leitura não. Escrita certa, leitura errada, 535 saldos invisíveis.
    const lista = telefones.map((t) => '"' + t + '"').join(',');
    const q = await sb('/base_clientes?select=telefone_e164,saldo_pontos,sem_whatsapp' +
      '&telefone_e164=' + encodeURIComponent('in.(' + lista + ')'));
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
    if (seco) {
      const ptsSeco = Number(saldos[tel]) || 0;
      const novoSeco = String(process.env.TEMPLATE_PONTOS || '').trim() === 'agradecimento';
      const tplSeco = novoSeco ? (ptsSeco >= 100 ? 'agradecimento_pontos_resgate' : 'agradecimento_pontos_acumulando') : 'atualizacao_cadastro_pontos';
      resultado.pontos.detalhe.push(tel + ' (simulado · ' + ptsSeco + ' pts · ' + tplSeco + ')');
      continue;
    }
    // Dois templates novos (24/09, pedido do Lucas), escolhidos pelo saldo:
    //   >= 100 pontos -> agradecimento_pontos_resgate:    {{1}} reais, {{2}} pontos, {{3}} pedido, {{4}} data
    //   <  100 pontos -> agradecimento_pontos_acumulando: {{1}} pontos, {{2}} faltam, {{3}} pedido, {{4}} data
    // Liga com TEMPLATE_PONTOS=agradecimento no Vercel. Sem a variavel = antigo.
    const pts = Number(saldos[tel]) || 0;
    const usarNovo = String(process.env.TEMPLATE_PONTOS || '').trim() === 'agradecimento';
    let tplPontos = 'atualizacao_cadastro_pontos';
    let parametrosPontos = [String(p.codigo), dataBR, String(saldos[tel])];
    if (usarNovo && pts >= 100) {
      tplPontos = 'agradecimento_pontos_resgate';
      const reais = (Math.floor(pts / 100) * 10).toFixed(2).replace('.', ',');
      parametrosPontos = [reais, String(pts), String(p.codigo), dataBR];
    } else if (usarNovo) {
      tplPontos = 'agradecimento_pontos_acumulando';
      parametrosPontos = [String(pts), String(100 - pts), String(p.codigo), dataBR];
    }
    const r = await enviar({
      telefone: tel,
      template: tplPontos,
      idioma: 'pt_BR',
      parametros: parametrosPontos,
      chave: 'pontos|' + tel + '|' + hoje,
      forcar: true,
    });
    if (r.aceito) resultado.pontos.enviados++;
    else { resultado.pontos.recusados++; resultado.pontos.detalhe.push(tel + ': ' + r.erro); }
    await new Promise((x) => setTimeout(x, 300));
  }

  // =========================================================================
  // PARTE 2 — FECHAMENTO do caixa
  // =========================================================================

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

  // kg e buffet livre: só existem se o PC gravou. Nunca inventar.
  const buf = await sb('/buffet_dia?select=kg,valor_kg,livre_qtd,livre_valor&dia=eq.' + hoje);
  const b = (buf.ok && Array.isArray(buf.corpo) && buf.corpo[0]) ? buf.corpo[0] : null;

  const NC = '(não confirmado)';
  const linhaKg = b && b.kg
    ? dinheiro(b.kg) + ' kg  (R$ ' + dinheiro(b.valor_kg) + ')'
    : NC;
  const linhaLivre = b && b.livre_qtd
    ? b.livre_qtd + ' pessoas  (R$ ' + dinheiro(b.livre_valor) + ')'
    : NC;

  const pedidos = Number(n.pedidos || 0);
  const ident = Number(n.identificados || 0);
  const novos = Number(n.novos || 0);
  const pct = (v) => pedidos ? Math.round((v / pedidos) * 100) : 0;

  const blocoClientes =
    '*CLIENTES — ' + pedidos + ' pedidos*\n\n' +
    '• novos cadastros: ' + novos + '\n' +
    '• voltaram: ' + Math.max(0, ident - novos) + '\n' +
    '• identificados: ' + ident + '  (' + pct(ident) + '%)\n' +
    '• não cadastrados: ' + (pedidos - ident) + '  (' + pct(pedidos - ident) + '%)';

  const completo =
    '*VARANDA — ' + hojeBR + ' (' + diaSemana + ')*\n\n' +
    '*FATURAMENTO TOTAL: R$ ' + dinheiro(n.total) + '*\n\n' +
    '• salão: R$ ' + dinheiro(n.salao) + '  (' + (n.salao_qtd || 0) + ' pedidos)\n' +
    '• delivery: R$ ' + dinheiro(n.delivery) + '  (' + (n.delivery_qtd || 0) + ' pedidos)\n' +
    '• balcão: R$ ' + dinheiro(n.balcao) + '  (' + (n.balcao_qtd || 0) + ' pedidos)\n\n' +
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

  // 22/09/2026 -- DECISAO DO LUCAS: o fechamento para a EQUIPE vai SO por
  // Telegram. O WhatsApp para os gestores foi desligado: custava mensagem,
  // caia fora da janela de 24h da Meta quase todo dia (131047) e chegava em
  // duplicidade com o Telegram. O WhatsApp fica so para CLIENTE (pontos).
  // Para religar, trocar `false &&` por nada. A lista EQUIPE fica como
  // documentacao de quem recebe o relatorio (no Telegram, via TELEGRAM_CHAT_ID).
  if (false && !seco) {
    for (const p of EQUIPE) {
      const texto = p.completo ? completo :
        '*VARANDA — ' + hojeBR + '*\n\n' + blocoClientes +
        '\n\n_Responda OK para manter o envio gratuito._';
      const r = await enviar({
        telefone: p.telefone,
        texto,
        chave: 'fechamento|' + p.telefone + '|' + hoje,
        forcar: true,
      });
      if (r.aceito) resultado.fechamento.enviados++;
      else { resultado.fechamento.falharam++; resultado.fechamento.detalhe.push(p.nome + ': ' + r.erro); }
      await new Promise((x) => setTimeout(x, 400));
    }
  }

  // -------------------------------------------------------------------------
  // TELEGRAM — canal interno, adicionado em 11/09/2026 (ideia do Lucas).
  // O relatorio falhava quase todo dia para o Leopoldo por causa da janela de
  // 24h da Meta (erro 131047). No Telegram nao existe janela, template nem
  // custo por mensagem. O WhatsApp continua para CLIENTE; o relatorio interno
  // passa a ter aqui a sua fonte confiavel.
  // Nunca derruba a rotina: se falhar, apenas registra o motivo.
  // -------------------------------------------------------------------------
  if (!seco) {
    const tg = await enviarTelegram(completo);
    resultado.telegram = { enviado: !!tg.ok, erro: tg.erro || null };

    // Registro do envio: e isto que a guarda la em cima consulta, e e o unico
    // lugar onde da para conferir pelo banco se o Telegram foi.
    await sb('/execucoes_log', {
      method: 'POST',
      body: JSON.stringify({
        rotina: 'rotina-diaria', sucesso: true,
        terminado_em: new Date().toISOString(),
        enviados: (resultado.pontos && resultado.pontos.enviados) || 0,
        falhados: (resultado.pontos && resultado.pontos.recusados) || 0,
        mensagem: 'enviado' + (forcarRotina ? ' (forcado/reenvio)' : '') + ': pontos=' + ((resultado.pontos && resultado.pontos.enviados) || 0)
          + ' telegram=' + (tg.ok ? 'ok' : ('FALHOU ' + (tg.erro || ''))),
      }),
    }).catch(() => {});
  }

  // ⚠️ 'enviados' aqui significa ACEITO PELA META, não entregue.
  // A verdade sobre entrega vem do webhook. Ver /api/status.
  resultado.aviso =
    'Os números de "enviados" são ACEITOS na fila da Meta. Entrega real só pelo ' +
    'webhook — consulte /api/status?minutos=15.';

  return responder(res, 200, resultado);
};
