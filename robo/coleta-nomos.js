// ============================================================================
// O ROBÔ DE COLETA DO NOMOS  (22/09/2026)
// ============================================================================
//
// Roda no GitHub Actions, todo dia às 14h (seg–sáb), sem PC nenhum ligado.
// Abre um navegador invisível, FAZ O LOGIN no Nomos com usuário e senha que
// vivem no cofre do GitHub, lê pedidos / pontos / kg / buffet, e grava tudo
// pelas MESMAS portas que o coletor humano usava (/api/importar e /api/coleta).
// Às 15h a rotina da Vercel (/api/rotina-diaria) encontra a coleta completa e
// manda os pontos e o fechamento sozinha.
//
// POR QUE EXISTE
// De 15 a 22/09/2026 o coletor humano (uma conversa do Claude no PC do
// Varanda, disparada quando alguém digitava "execute") ficou parado, e com ele
// pararam os pontos e o fechamento. Ninguém digitou "execute" porque ninguém é
// obrigado a lembrar. Além disso, todo caminho baseado em cookie salvo vence
// em semanas. Este robô faz o login de verdade, todo dia, então não há cookie
// para vencer nem pessoa para lembrar.
//
// O QUE ELE FAZ, NA ORDEM
//   0. login no Nomos (usuário/senha do cofre)              -> falhou? avisa e para
//   1. /api/coleta {acao:'inicio'}                          -> abre a coleta do dia
//   2. pedidos dos últimos 7 dias, pela tabela do gestorpedido (o mesmo
//      método que funcionou por semanas) -> /api/importar -> {acao:'pedidos'}
//   3. listarJson (o atalho JSON) só para os PRODUTOS: kg e buffet livre
//      -> {acao:'buffet'}
//   4. CRM > Programa de Fidelidade > olho > #tabelaRelatorio -> {acao:'pontos'}
//   5. {acao:'concluir'}                                     -> marca completa
//   6. manda o cookie da sessão para /api/nomos-sessao (bônus: o servidor
//      passa a conseguir ler o Nomos sozinho até o cookie vencer)
//   7. {acao:'fechar_log'} e um resumo de uma linha no Telegram
//
// O QUE ELE NÃO FAZ (de propósito)
//   - Não manda WhatsApp. Nunca chama /api/enviar nem /api/rotina-diaria.
//     Quem envia é o cron das 15h. Coletar e enviar são coisas separadas.
//   - Não lê despesas (Google Sheets) nem o Portal do iFood. O relatório sai
//     com "(não confirmado)" nesses campos, como o desenho já previa.
//   - Não inventa número. Se não achou o kg, não manda kg. O servidor recusa
//     a coleta como completa e o Telegram diz exatamente o que faltou.
//
// SEGURANÇA
//   - A senha entra só em page.fill('#senha', ...). Nunca em log, nunca em
//     mensagem, nunca em erro. O GitHub ainda mascara os secrets no log.
//   - Um token só (VARANDA_TOKEN). Ele abre /api/coleta, /api/importar e
//     /api/telegram. Nunca abre /api/enviar em modo de envio de campanha.
//
// VARIÁVEIS DE AMBIENTE (secrets do GitHub)
//   NOMOS_USUARIO   NOMOS_SENHA   VARANDA_TOKEN
//   BACKEND (opcional, padrão https://varanda-backend.vercel.app)
//   SO_TESTAR_LOGIN=1 (opcional): faz o login, confere, e para. Não grava nada.
// ============================================================================

'use strict';

const { chromium } = require('playwright');

const NOMOS = 'https://www.nomosmenu.com.br';
const BACKEND = (process.env.BACKEND || 'https://varanda-backend.vercel.app').replace(/\/$/, '');
const TOKEN = String(process.env.VARANDA_TOKEN || '').trim();
const USUARIO = String(process.env.NOMOS_USUARIO || '').trim();
const SENHA = String(process.env.NOMOS_SENHA || '');
const SO_TESTAR_LOGIN = process.env.SO_TESTAR_LOGIN === '1';

const DIAS_DE_HISTORICO = 7;          // igual ao coletor humano: um dia perdido se corrige no seguinte
const ESPERA_TABELA_MS = 30000;

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------
const log = (...a) => console.log('[robo]', new Date().toISOString(), ...a);
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const dd = (n) => String(n).padStart(2, '0');

/** Data de Brasília, sem depender do fuso da máquina do GitHub (que é UTC). */
function agoraBR() { return new Date(Date.now() - 3 * 3600 * 1000); }
function dataBR(d) { return dd(d.getUTCDate()) + '/' + dd(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(); }
function hojeISO() { return agoraBR().toISOString().slice(0, 10); }

/** Nunca deixa a senha vazar por acidente numa mensagem de erro. */
function semSegredo(txt) {
  let s = String(txt == null ? '' : txt);
  if (SENHA && SENHA.length >= 3) s = s.split(SENHA).join('***');
  if (TOKEN && TOKEN.length >= 3) s = s.split(TOKEN).join('***');
  return s;
}

/** Chamada ao nosso backend, com o token. Sempre devolve {ok, status, corpo}. */
async function backend(caminho, corpo, metodo) {
  const r = await fetch(BACKEND + caminho, {
    method: metodo || 'POST',
    headers: { 'Content-Type': 'application/json', 'x-varanda-token': TOKEN },
    body: metodo === 'GET' ? undefined : JSON.stringify(corpo || {}),
  });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) { j = { bruto: txt.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, corpo: j };
}

const coleta = (corpo) => backend('/api/coleta', corpo);

/** Aviso para a EQUIPE. Falhar aqui nunca derruba o robô. */
async function telegram(texto) {
  try {
    const t = semSegredo(texto).slice(0, 3500);
    const r = await fetch(BACKEND + '/api/telegram?acao=enviar&token=' + encodeURIComponent(TOKEN)
      + '&texto=' + encodeURIComponent(t));
    log('telegram:', r.status);
  } catch (e) { log('telegram falhou:', semSegredo(e && e.message)); }
}

// ---------------------------------------------------------------------------
// PASSO 0 — LOGIN
// ---------------------------------------------------------------------------
// A tela é um formulário simples: #usuario, #senha, #flagRememberLogin,
// #btnLogar (type=button, o JS da página faz o POST). Sem captcha, sem SMS.
// Prova de login: abrir o gestorpedido e NÃO ver o campo #senha.
async function login(page) {
  await page.goto(NOMOS + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#usuario', { timeout: 30000 });
  await page.fill('#usuario', USUARIO);
  await page.fill('#senha', SENHA);
  const lembrar = await page.$('#flagRememberLogin');
  if (lembrar && !(await lembrar.isChecked())) await lembrar.check().catch(() => {});
  await page.click('#btnLogar');

  // Espera o formulário sumir OU a URL mudar OU um erro aparecer.
  const limite = Date.now() + 45000;
  while (Date.now() < limite) {
    await dorme(1000);
    const temSenha = await page.$('#senha');
    if (!temSenha) break;
    const erro = await page.evaluate(() => {
      const el = document.querySelector('.jconfirm-content, .alert-danger, .notificacao, .toast-message, .swal2-html-container');
      return el ? el.innerText.trim().slice(0, 200) : '';
    }).catch(() => '');
    if (erro) throw new Error('Nomos recusou o login: ' + erro);
  }

  await page.goto(NOMOS + '/app/varanda/gestorpedido', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dorme(2000);
  if (await page.$('#senha')) {
    throw new Error('LOGIN FALHOU: depois de enviar usuário e senha o Nomos continuou na tela de login. '
      + 'Ou a senha mudou, ou o Nomos bloqueou. Ninguém digitou nada errado por aqui — conferir NOMOS_USUARIO / NOMOS_SENHA no cofre.');
  }
  const cookie = await page.evaluate(() => document.cookie).catch(() => '');
  log('login ok. cookies na página:', (cookie.match(/=/g) || []).length);
  return cookie;
}

// ---------------------------------------------------------------------------
// PASSO 2 — PEDIDOS (pela tabela, o método que funcionou por semanas)
// ---------------------------------------------------------------------------
// Portado de "PC VARANDA/1 - COLETOR (EXECUTE)/coleta_nomos.js". Mesmo filtro,
// mesma espera, mesmas 5 colunas. A data final é AMANHÃ de propósito: o Nomos
// trata dataFim como "até aquele dia 00:00" e EXCLUI o dia inteiro (19/08).
async function lerPedidos(page) {
  const fim = new Date(agoraBR().getTime() + 86400000);
  const ini = new Date(agoraBR().getTime() - DIAS_DE_HISTORICO * 86400000);
  const sIni = dataBR(ini), sFim = dataBR(fim);
  log('pedidos: filtrando', sIni, 'a', sFim, '(fim = amanhã, de propósito)');

  await page.waitForFunction(() => window.jQuery && jQuery.fn && jQuery.fn.DataTable, null, { timeout: 30000 });

  const resultado = await page.evaluate(async ({ sIni, sFim, esperaMs }) => {
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('Filtro não encontrado: ' + sel + ' — o Nomos mudou o layout.');
      el.value = v; el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('#dataInicio', sIni);
    set('#dataFim', sFim);
    set('#dataInicioFim', sIni + ' - ' + sFim);
    set('#numero_registros', '10000');

    const tabela = () => jQuery('#dataTablePedidos').DataTable();
    const antes = tabela().rows().count();
    document.querySelector('#btnPesquisar').click();

    const limite = Date.now() + esperaMs;
    let agora = antes;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 1000));
      agora = tabela().rows().count();
      if (agora !== antes) break;
    }
    await new Promise((r) => setTimeout(r, 2500));

    const dt = tabela();
    const total = dt.rows().count();
    const celula = (i, j) => { const n = dt.cell(i, j).node(); return n ? n.innerText.trim().replace(/\s+/g, ' ') : ''; };
    const pedidos = [];
    for (let i = 0; i < total; i++) {
      const cod = (celula(i, 0).match(/^\d+/) || [''])[0];
      if (!cod) continue;
      pedidos.push({ codigo: cod, tipo: celula(i, 1), valor: celula(i, 2), data: celula(i, 3), cliente: celula(i, 4) });
    }
    return { total, pedidos, mudou: agora !== antes };
  }, { sIni, sFim, esperaMs: ESPERA_TABELA_MS });

  if (!resultado.pedidos.length) {
    throw new Error('A pesquisa de pedidos voltou vazia (' + resultado.total + ' linhas). Não vou importar nada.');
  }
  const hojeBR = dd(agoraBR().getUTCDate()) + '/' + dd(agoraBR().getUTCMonth() + 1);
  const temHoje = resultado.pedidos.some((p) => String(p.data || '').startsWith(hojeBR));
  log('pedidos lidos:', resultado.pedidos.length, '· tem pedidos de hoje:', temHoje);
  return { pedidos: resultado.pedidos, temHoje };
}

async function importarPedidos(pedidos) {
  const ano = agoraBR().getUTCFullYear();
  const resumo = { lidos: pedidos.length, novos: 0, ja_existiam: 0, identificados: 0, problemas: [] };
  for (let i = 0; i < pedidos.length; i += 1000) {
    const r = await backend('/api/importar', { pedidos: pedidos.slice(i, i + 1000), ano });
    if (!r.ok) throw new Error('/api/importar recusou (HTTP ' + r.status + '): ' + JSON.stringify(r.corpo).slice(0, 300));
    resumo.novos += r.corpo.novos_gravados || 0;
    resumo.ja_existiam += r.corpo.ja_existiam || 0;
    resumo.identificados += r.corpo.identificados || 0;
    if (Array.isArray(r.corpo.problemas)) resumo.problemas.push(...r.corpo.problemas);
  }
  log('importar:', JSON.stringify({ ...resumo, problemas: resumo.problemas.length }));
  return resumo;
}

// ---------------------------------------------------------------------------
// PASSO 3 — KG E BUFFET LIVRE (pelo listarJson, só os produtos)
// ---------------------------------------------------------------------------
// Chamado DENTRO da página, com a sessão do navegador. Devolve, entre outras
// coisas, cardapio_produto_quantidade com nome_produto, quantidade_produto,
// total_vendido e flag_tipo_unidade — número limpo, sem regex de tela.
// Só HOJE aqui (dataFim = amanhã), porque kg e buffet são do dia.
async function lerProdutosDeHoje(page) {
  const hoje = dataBR(agoraBR());
  const amanha = dataBR(new Date(agoraBR().getTime() + 86400000));
  const j = await page.evaluate(async ({ hoje, amanha }) => {
    const r = await fetch('/app/varanda/gestorpedido/listarJson', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({
        dataInicio: hoje, dataFim: amanha,
        horaInicio: '', horaFim: '', cliente: '', pedido_desconto: '', nfc_gerada: '',
        clienteRegistrado: '', numeroMesa: '', codigoPedidoDiario: '',
        flag_pedido_agendado: '', dataInicioAgendamento: '', dataFimAgendamento: '',
        numero_registros: '10000', ordenacao: '',
      }).toString(),
    });
    if (!r.ok) return { erro: 'HTTP ' + r.status };
    return r.json();
  }, { hoje, amanha });

  if (!j || j.erro) { log('listarJson falhou:', j && j.erro); return null; }

  const produtos = Array.isArray(j.cardapio_produto_quantidade) ? j.cardapio_produto_quantidade : [];
  // Para a evolução do robô: só os NOMES dos campos e dos produtos, nunca dado de cliente.
  const ped = Array.isArray(j.pedidos_json) ? j.pedidos_json : [];
  log('listarJson: pedidos_hoje=' + ped.length + ' produtos=' + produtos.length
    + ' campos_pedido=' + JSON.stringify(ped[0] ? Object.keys(ped[0]) : [])
    + ' campos_produto=' + JSON.stringify(produtos[0] ? Object.keys(produtos[0]) : []));
  log('produtos de hoje:', JSON.stringify(produtos.map((p) => [p.nome_produto, p.quantidade_produto, p.total_vendido, p.flag_tipo_unidade])));
  return { produtos, faturamento: j.valor_total, qtd_pedidos: j.quantidade_pedido };
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Acha o buffet por kg e o buffet livre na lista de produtos.
 * Heurística pelo nome e pela unidade. Se não achar com segurança, devolve
 * null naquele campo — e o servidor vai recusar "concluir", o que é o certo.
 */
function extrairBuffet(produtos) {
  const nome = (p) => String(p.nome_produto || '').toLowerCase();
  const unidade = (p) => String(p.flag_tipo_unidade == null ? '' : p.flag_tipo_unidade).toLowerCase();

  const kgItens = produtos.filter((p) => /\bkg\b|quilo|por peso|self[- ]?service/.test(nome(p)) || unidade(p) === 'kg' || unidade(p) === '2');
  const livreItens = produtos.filter((p) => /buffet\s*livre|livre/.test(nome(p)) && !/kg|quilo/.test(nome(p)));

  const soma = (itens, campo) => itens.reduce((t, p) => t + (num(p[campo]) || 0), 0);
  const kg = kgItens.length ? soma(kgItens, 'quantidade_produto') : null;
  const valorKg = kgItens.length ? soma(kgItens, 'total_vendido') : null;
  const livreQtd = livreItens.length ? soma(livreItens, 'quantidade_produto') : null;
  const livreValor = livreItens.length ? soma(livreItens, 'total_vendido') : null;

  return {
    kg, valor_kg: valorKg, livre_qtd: livreQtd, livre_valor: livreValor,
    achou_kg: kgItens.map((p) => p.nome_produto), achou_livre: livreItens.map((p) => p.nome_produto),
  };
}

// ---------------------------------------------------------------------------
// PASSO 4 — PONTOS (CRM > Programa de Fidelidade > olho)
// ---------------------------------------------------------------------------
// Colunas conhecidas: Código, Nome, Telefone, Pontos prog. fidelidade.
// Acho as colunas pelo cabeçalho, com esses índices como reserva.
// O telefone vai COMO ESTÁ — quem normaliza é o servidor (nono dígito, 0800...).
async function lerPontos(page) {
  await page.goto(NOMOS + '/app/varanda/crm', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('button.btnCrmRelatorioVisualizar', { timeout: 30000 });

  // Há um botão por relatório; quero o da linha "Programa de Fidelidade".
  const clicou = await page.evaluate(() => {
    const botoes = [...document.querySelectorAll('button.btnCrmRelatorioVisualizar')];
    const alvo = botoes.find((b) => /fidelidade/i.test((b.closest('tr') || b.parentElement).innerText)) || botoes[0];
    if (!alvo) return false;
    alvo.click(); return true;
  });
  if (!clicou) throw new Error('Não achei o botão do relatório de fidelidade no CRM.');

  await page.waitForSelector('#tabelaRelatorio', { timeout: 30000 });
  await page.waitForFunction(() => window.jQuery && jQuery.fn.DataTable && jQuery.fn.DataTable.isDataTable('#tabelaRelatorio'), null, { timeout: 30000 });
  await dorme(1500);

  const clientes = await page.evaluate(() => {
    const dt = jQuery('#tabelaRelatorio').DataTable();
    dt.page.len(-1).draw();
    const cab = [...document.querySelectorAll('#tabelaRelatorio thead th')].map((th) => th.innerText.trim().toLowerCase());
    let iTel = cab.findIndex((t) => /telefone|celular|whats/.test(t));
    let iPts = cab.findIndex((t) => /ponto|saldo/.test(t));
    if (iTel < 0) iTel = 2;
    if (iPts < 0) iPts = 3;
    const dados = dt.rows().data().toArray();
    const txt = (v) => String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const linha of dados) {
      const cel = Array.isArray(linha) ? linha : Object.values(linha);
      const telefone = txt(cel[iTel]);
      const saldo = parseInt(txt(cel[iPts]).replace(/\D/g, ''), 10);
      if (telefone && Number.isFinite(saldo)) out.push({ telefone, saldo });
    }
    return { total_linhas: dados.length, cabecalho: cab, clientes: out };
  });

  log('pontos: linhas=' + clientes.total_linhas + ' aproveitáveis=' + clientes.clientes.length
    + ' cabeçalho=' + JSON.stringify(clientes.cabecalho));
  if (!clientes.clientes.length) throw new Error('Relatório de fidelidade veio sem linhas aproveitáveis.');
  return clientes.clientes;
}

// ---------------------------------------------------------------------------
// PRINCIPAL
// ---------------------------------------------------------------------------
(async function principal() {
  const inicio = Date.now();
  const hoje = hojeISO();
  const detalhe = { dia: hoje, passo: 'inicio' };
  let execucaoId = null;
  let browser = null;

  const falhar = async (passo, e) => {
    const msg = semSegredo(e && e.message ? e.message : e);
    log('FALHOU no passo', passo, '->', msg);
    await telegram('VARANDA - ROBO DE COLETA FALHOU (' + hoje + ')\nPasso: ' + passo + '\nErro: ' + msg
      + '\n\nOs pontos das 15h NAO vao sair hoje (a trava de coleta bloqueia). '
      + (passo === 'login'
        ? 'Conferir usuario/senha do Nomos no cofre do GitHub (Settings > Secrets).'
        : 'Ver o log da execucao no GitHub Actions.'));
    if (execucaoId) {
      await coleta({ acao: 'fechar_log', execucao_id: execucaoId, sucesso: false, mensagem: 'robô falhou em ' + passo + ': ' + msg.slice(0, 300), detalhe }).catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  };

  if (!USUARIO || !SENHA || !TOKEN) {
    return falhar('config', new Error('Faltam variáveis: ' + [!USUARIO && 'NOMOS_USUARIO', !SENHA && 'NOMOS_SENHA', !TOKEN && 'VARANDA_TOKEN'].filter(Boolean).join(', ')));
  }

  try {
    browser = await chromium.launch({ headless: true });
    const contexto = await browser.newContext({
      locale: 'pt-BR', timezoneId: 'America/Sao_Paulo',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
    });
    const page = await contexto.newPage();
    page.setDefaultTimeout(45000);

    // 0 — login
    detalhe.passo = 'login';
    let cookie = '';
    try { cookie = await login(page); } catch (e) { return falhar('login', e); }
    if (SO_TESTAR_LOGIN) {
      log('SO_TESTAR_LOGIN=1: login funcionou, parando aqui sem gravar nada.');
      await telegram('VARANDA - teste do robo: LOGIN NO NOMOS FUNCIONOU (' + hoje + '). Nada foi gravado.');
      await browser.close(); return;
    }

    // 1 — inicio
    detalhe.passo = 'inicio';
    const ini = await coleta({ acao: 'inicio' });
    if (!ini.ok) return falhar('inicio', new Error('/api/coleta inicio HTTP ' + ini.status + ' ' + JSON.stringify(ini.corpo).slice(0, 200)));
    execucaoId = ini.corpo && ini.corpo.execucao_id;
    log('execucao_id', execucaoId);

    // 2 — pedidos
    detalhe.passo = 'pedidos';
    let ped;
    try { ped = await lerPedidos(page); } catch (e) { return falhar('pedidos', e); }
    const imp = await importarPedidos(ped.pedidos).catch((e) => { throw e; });
    detalhe.pedidos_lidos = ped.pedidos.length; detalhe.pedidos_novos = imp.novos; detalhe.problemas_importar = imp.problemas.length;
    if (!ped.temHoje) return falhar('pedidos', new Error('Nenhum pedido com a data de hoje nos ' + ped.pedidos.length + ' lidos. Ou o caixa não lançou nada, ou o filtro de data quebrou.'));
    const rp = await coleta({ acao: 'pedidos', lidos: ped.pedidos.length, tem_pedidos_de_hoje: true });
    if (!rp.ok) return falhar('pedidos', new Error(JSON.stringify(rp.corpo).slice(0, 300)));

    // 3 — kg e buffet
    detalhe.passo = 'buffet';
    const prod = await lerProdutosDeHoje(page);
    let buffetOk = false, buffetMotivo = 'listarJson não respondeu';
    if (prod) {
      const b = extrairBuffet(prod.produtos);
      detalhe.buffet = { kg: b.kg, valor_kg: b.valor_kg, livre_qtd: b.livre_qtd, livre_valor: b.livre_valor, achou_kg: b.achou_kg, achou_livre: b.achou_livre };
      if (b.kg && b.valor_kg) {
        const corpo = { acao: 'buffet', kg: b.kg, valor_kg: b.valor_kg };
        if (b.livre_qtd && b.livre_valor) { corpo.livre_qtd = b.livre_qtd; corpo.livre_valor = b.livre_valor; }
        const rb = await coleta(corpo);
        buffetOk = rb.ok;
        buffetMotivo = rb.ok ? 'ok' : ('servidor recusou: ' + JSON.stringify(rb.corpo && (rb.corpo.problemas || rb.corpo.erro)).slice(0, 300));
      } else {
        buffetMotivo = 'não achei o produto por kg entre: ' + prod.produtos.map((p) => p.nome_produto).join(' | ').slice(0, 400);
      }
    }
    detalhe.buffet_ok = buffetOk; detalhe.buffet_motivo = buffetMotivo;
    log('buffet:', buffetOk ? 'ok' : buffetMotivo);

    // 4 — pontos
    detalhe.passo = 'pontos';
    let clientes;
    try { clientes = await lerPontos(page); } catch (e) { return falhar('pontos', e); }
    const rpt = await coleta({ acao: 'pontos', clientes });
    if (!rpt.ok) return falhar('pontos', new Error(JSON.stringify(rpt.corpo).slice(0, 300)));
    detalhe.pontos_gravados = rpt.corpo.gravados; detalhe.pontos_recusados = rpt.corpo.recusados && rpt.corpo.recusados.length;
    log('pontos:', JSON.stringify({ gravados: rpt.corpo.gravados, recusados: detalhe.pontos_recusados }));

    // 5 — concluir
    detalhe.passo = 'concluir';
    const rc = await coleta({ acao: 'concluir' });
    detalhe.completa = !!(rc.ok && rc.corpo && rc.corpo.completa);
    detalhe.pode_enviar = !!(rc.ok && rc.corpo && rc.corpo.pode_enviar);
    detalhe.faltando = rc.ok ? null : (rc.corpo && rc.corpo.faltando);

    // 6 — cookie para o servidor (bônus, nunca crítico)
    detalhe.passo = 'sessao';
    if (cookie) {
      const rs = await backend('/api/nomos-sessao', { cookie }).catch(() => null);
      log('nomos-sessao:', rs ? rs.status : 'falhou', rs && rs.corpo && rs.corpo.teste_imediato);
    }

    // 7 — fechar e avisar
    detalhe.passo = 'fim';
    detalhe.segundos = Math.round((Date.now() - inicio) / 1000);
    await coleta({ acao: 'fechar_log', execucao_id: execucaoId, sucesso: detalhe.completa, detalhe, mensagem: detalhe.completa ? 'robô: coleta completa' : 'robô: coleta parcial' });

    const linha = 'VARANDA - COLETA 14h ' + (detalhe.completa ? 'OK' : 'PARCIAL') + ' (' + hoje + ')\n'
      + 'Pedidos lidos: ' + detalhe.pedidos_lidos + ' (novos: ' + detalhe.pedidos_novos + ')\n'
      + 'Saldos de pontos gravados: ' + detalhe.pontos_gravados + '\n'
      + 'Kg/buffet: ' + (buffetOk ? ('kg ' + detalhe.buffet.kg + ' · livre ' + (detalhe.buffet.livre_qtd || 0)) : ('NAO -> ' + buffetMotivo)) + '\n'
      + (detalhe.completa
        ? 'Pontos e fechamento saem as 15h sozinhos.'
        : 'Coleta NAO marcada como completa (faltou: ' + JSON.stringify(detalhe.faltando) + '). As 15h NAO vai enviar.');
    await telegram(linha);
    log(linha);

    await browser.close();
    process.exit(detalhe.completa ? 0 : 2);
  } catch (e) {
    return falhar(detalhe.passo, e);
  }
})();
