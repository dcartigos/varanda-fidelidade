// api/cardapio.js
// ============================================================================
// PUBLICACAO DO CARDAPIO DO DIA
// ============================================================================
//
// POR QUE ELE EXISTE
// O /api/campanha das 10h manda o cardapio do dia quando ele existe publicado, e
// cai na arte de rotacao quando nao existe. Mas nao havia jeito de publicar: a
// arte do cardapio e gerada em Python na maquina do Varanda (a fonte
// LiberationSansNarrow-Bold so existe la) e nao tinha para onde ir.
//
// Este arquivo e essa ponte. Ele faz DUAS coisas no mesmo endereco:
//
//   GET  /api/cardapio   -> devolve a PAGINA de publicacao (a tela da Maria)
//   POST /api/cardapio   -> recebe os pratos + a imagem, sobe no Storage do
//                           Supabase e grava a linha em cardapio_dia
//
// POR QUE A PAGINA VEM DE DENTRO DO ENDPOINT, E NAO E UM .html SOLTO
// Neste projeto a pasta raiz da Vercel e 'backend-varanda' e nao existe nenhum
// arquivo estatico servido ali (o index.html do repositorio esta fora dessa
// pasta). Em vez de descobrir a configuracao de estaticos no dia em que a Maria
// precisar publicar, a pagina sai de /api/, que e o unico caminho que este
// projeto comprovadamente serve.
//
// POR QUE STORAGE DO SUPABASE E NAO GITHUB
// O upload da interface do GitHub NAO sobrescreve arquivo existente de forma
// confiavel: em 22/08/2026 duas versoes de uma arte foram "enviadas" e o raw
// continuou servindo a antiga por horas. Storage e um POST, devolve a URL na
// hora, e o nome do arquivo leva a data + um sufixo, entao cache nunca morde.
//
// SEGURANCA
// Aceita IMPORT_TOKEN (o mesmo que o COLETOR ja guarda no navegador do PC do
// Varanda) ou APP_TOKEN. O IMPORT_TOKEN so abre importacao e publicacao de
// arte: ele NAO manda WhatsApp. Se vazar, o pior que acontece e alguem publicar
// uma arte que ainda passaria pela aprovacao da Maria.

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'artes';

// ---------------------------------------------------------------------------
function agoraSP() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

function hojeISO() {
  const a = agoraSP();
  return a.getFullYear() + '-' + String(a.getMonth() + 1).padStart(2, '0')
    + '-' + String(a.getDate()).padStart(2, '0');
}

function cabecalhosSB(extra) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: 'Bearer ' + SB_KEY,
  }, extra || {});
}

// Garante que o bucket publico existe. Roda uma vez na vida e depois devolve
// "ja existe" -- deixar isso no codigo evita um passo manual no dashboard que
// alguem esqueceria de fazer.
async function garantirBucket() {
  const r = await fetch(SB_URL + '/storage/v1/bucket/' + BUCKET, {
    headers: cabecalhosSB(),
  });
  if (r.ok) return { ok: true, criado: false };

  const c = await fetch(SB_URL + '/storage/v1/bucket', {
    method: 'POST',
    headers: cabecalhosSB({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: true,                       // a Meta precisa baixar a imagem sem login
      file_size_limit: 5242880,           // 5 MB, o teto da Meta para imagem
      allowed_mime_types: ['image/jpeg', 'image/png'],
    }),
  });
  const corpo = await c.text();
  if (!c.ok) return { ok: false, erro: corpo };
  return { ok: true, criado: true };
}

// ---------------------------------------------------------------------------
// A PAGINA (GET)
// ---------------------------------------------------------------------------
const PAGINA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cardapio do dia - Varanda</title>
<style>
 :root{--verde:#123528;--creme:#faf6ec;--dourado:#c8952f;--erro:#a4262c}
 *{box-sizing:border-box}
 body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
      background:var(--creme);color:var(--verde)}
 main{max-width:640px;margin:0 auto;padding:24px 18px 64px}
 h1{font-size:22px;margin:0 0 4px}
 p.sub{margin:0 0 24px;color:#5b6b62;font-size:14px}
 label{display:block;font-weight:600;margin:20px 0 6px;font-size:14px}
 textarea,input[type=text],input[type=password]{width:100%;padding:11px 12px;
   border:1.5px solid #d8d2c0;border-radius:8px;font:inherit;background:#fff}
 textarea{min-height:170px;resize:vertical}
 input[type=file]{width:100%;padding:11px;border:1.5px dashed #c9c2ae;
   border-radius:8px;background:#fff}
 button{margin-top:24px;width:100%;padding:15px;border:0;border-radius:8px;
   background:var(--verde);color:#fff;font:600 17px/1 inherit;cursor:pointer}
 button:disabled{opacity:.45;cursor:not-allowed}
 #saida{margin-top:22px;padding:14px;border-radius:8px;display:none;
   font-size:14px;white-space:pre-wrap;word-break:break-word}
 .ok{background:#e6f3ea;border:1px solid #9ccfae}
 .ruim{background:#fbe9ea;border:1px solid #e5a6a9;color:var(--erro)}
 img#previa{max-width:100%;margin-top:14px;border-radius:8px;display:none}
 small{color:#6b7a71;font-size:13px;display:block;margin-top:6px}
</style></head><body><main>
 <h1>Cardapio do dia</h1>
 <p class="sub">Publica a arte de hoje. Depois disso o disparo das 10h manda ela
 em vez da arte de rotacao. Nada e enviado por esta tela.</p>

 <label for="pratos">Pratos de hoje <small>um por linha</small></label>
 <textarea id="pratos" placeholder="frango assado&#10;contra file&#10;feijoada&#10;lasanha a bolonhesa"></textarea>

 <label for="arquivo">A arte gerada (.jpg)</label>
 <input type="file" id="arquivo" accept="image/jpeg,image/png">
 <img id="previa" alt="previa da arte">

 <label for="token">Senha do sistema <small>fica salva so neste navegador</small></label>
 <input type="password" id="token" autocomplete="off">

 <button id="botao">Publicar o cardapio de hoje</button>
 <div id="saida"></div>
</main>
<script>
 var $ = function(id){ return document.getElementById(id); };
 var GUARDADO = 'varanda_import_token';
 try { $('token').value = localStorage.getItem(GUARDADO) || ''; } catch(e){}

 $('arquivo').addEventListener('change', function(){
   var f = this.files && this.files[0];
   if (!f) { $('previa').style.display = 'none'; return; }
   $('previa').src = URL.createObjectURL(f);
   $('previa').style.display = 'block';
 });

 function mostrar(texto, bom){
   var s = $('saida');
   s.textContent = texto;
   s.className = bom ? 'ok' : 'ruim';
   s.style.display = 'block';
 }

 function base64De(arquivo){
   return new Promise(function(ok, falhou){
     var fr = new FileReader();
     fr.onload = function(){ ok(String(fr.result).split(',')[1]); };
     fr.onerror = function(){ falhou(new Error('nao consegui ler o arquivo')); };
     fr.readAsDataURL(arquivo);
   });
 }

 $('botao').addEventListener('click', async function(){
   var pratos = $('pratos').value.split('\\n')
       .map(function(s){ return s.trim(); })
       .filter(function(s){ return s.length > 1; });
   var arquivo = $('arquivo').files && $('arquivo').files[0];
   var token = $('token').value.trim();

   if (pratos.length < 3) { return mostrar('Escreva pelo menos 3 pratos, um por linha.', false); }
   if (!arquivo)          { return mostrar('Escolha o arquivo da arte (.jpg).', false); }
   if (!token)            { return mostrar('Falta a senha do sistema.', false); }

   this.disabled = true;
   mostrar('Publicando...', true);
   try {
     var b64 = await base64De(arquivo);
     var r = await fetch(location.pathname, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', 'x-varanda-token': token },
       body: JSON.stringify({ pratos: pratos, imagem_base64: b64,
                              aprovado_por: 'tela de publicacao' })
     });
     var c = await r.json();
     if (!r.ok) {
       if (r.status === 401) { try { localStorage.removeItem(GUARDADO); } catch(e){} }
       mostrar('NAO PUBLICOU\\n\\n' + JSON.stringify(c, null, 2), false);
     } else {
       try { localStorage.setItem(GUARDADO, token); } catch(e){}
       mostrar('PUBLICADO\\n\\n' + pratos.length + ' pratos\\ndata: ' + c.data_ref
               + '\\n\\nURL da arte:\\n' + c.url
               + '\\n\\nO disparo das 10h vai usar esta arte.', true);
     }
   } catch (e) {
     mostrar('Falhou: ' + (e && e.message ? e.message : e), false);
   }
   this.disabled = false;
 });
</script></body></html>`;

// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  // ---- A pagina -----------------------------------------------------------
  if (req.method === 'GET' && !(req.query && req.query.consultar)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(PAGINA);
  }

  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ erro: 'Supabase nao configurado no servidor.' });
  }

  // ---- Consulta: tem cardapio publicado hoje? -----------------------------
  // Serve para o agente do PC e para mim conferir sem precisar de token.
  if (req.method === 'GET') {
    const dia = String((req.query && req.query.data_ref) || hojeISO()).slice(0, 10);
    const r = await fetch(
      SB_URL + '/rest/v1/cardapio_dia?data_ref=eq.' + dia
        + '&select=data_ref,pratos,urls_artes,recebido_em,enviado_por&limit=1',
      { headers: cabecalhosSB() }
    );
    const linhas = await r.json().catch(() => null);
    const linha = Array.isArray(linhas) && linhas[0] ? linhas[0] : null;
    return res.status(200).json({
      data_ref: dia,
      publicado: Boolean(linha && linha.urls_artes && linha.urls_artes.principal),
      cardapio: linha,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Use GET (pagina/consulta) ou POST (publicar).' });
  }

  // ---- Autenticacao -------------------------------------------------------
  const recebido = String(req.headers['x-varanda-token']
    || (req.query && req.query.token) || '').trim();
  const aceitos = [process.env.IMPORT_TOKEN, process.env.APP_TOKEN]
    .filter(Boolean).map((s) => String(s).trim());
  if (!recebido || !aceitos.includes(recebido)) {
    return res.status(401).json({
      erro: 'Token invalido.',
      dica: 'Use o IMPORT_TOKEN (o mesmo do coletor). Nao use o APP_TOKEN no navegador.',
    });
  }

  const corpo = req.body || {};
  const pratos = Array.isArray(corpo.pratos)
    ? corpo.pratos.map((p) => String(p).trim()).filter((p) => p.length > 1)
    : null;

  if (!pratos || pratos.length < 3) {
    return res.status(400).json({ erro: 'Manda "pratos" como lista com pelo menos 3 itens.' });
  }
  if (pratos.length > 30) {
    return res.status(400).json({ erro: 'Mais de 30 pratos. Confere se nao veio texto colado errado.' });
  }
  if (!corpo.imagem_base64) {
    return res.status(400).json({ erro: 'Falta "imagem_base64" (a arte gerada).' });
  }

  // ---- A imagem -----------------------------------------------------------
  let bytes;
  try {
    bytes = Buffer.from(String(corpo.imagem_base64).replace(/^data:[^,]+,/, ''), 'base64');
  } catch (e) {
    return res.status(400).json({ erro: 'imagem_base64 nao e base64 valido.' });
  }

  // Confere pelos bytes iniciais, nao pela extensao do nome: em 22/08 um raw do
  // GitHub devolveu HTML de erro com nome .jpg e a Meta recusou o envio inteiro.
  const ehJPEG = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  const ehPNG = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  if (!ehJPEG && !ehPNG) {
    return res.status(400).json({
      erro: 'O arquivo nao e JPEG nem PNG (conferido pelos bytes, nao pelo nome).',
      primeiros_bytes: [...bytes.slice(0, 4)].map((b) => b.toString(16)),
    });
  }
  if (bytes.length < 20000) {
    return res.status(400).json({
      erro: 'Imagem com menos de 20 KB. A arte do cardapio tem ~250 KB -- isso parece arquivo truncado.',
      bytes: bytes.length,
    });
  }
  if (bytes.length > 5 * 1024 * 1024) {
    return res.status(400).json({ erro: 'Imagem acima de 5 MB, a Meta recusa.', bytes: bytes.length });
  }

  const b = await garantirBucket();
  if (!b.ok) return res.status(500).json({ erro: 'Nao consegui criar o bucket.', detalhe: b.erro });

  // Nome versionado: data + o tamanho em bytes. Republicar no mesmo dia gera
  // nome novo, entao nenhuma camada de cache pode servir a arte velha.
  const dia = String(corpo.data_ref || hojeISO()).slice(0, 10);
  const ext = ehPNG ? 'png' : 'jpg';
  const caminho = 'cardapio/' + dia + '-' + bytes.length + '.' + ext;

  const up = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + caminho, {
    method: 'POST',
    headers: cabecalhosSB({
      'Content-Type': ehPNG ? 'image/png' : 'image/jpeg',
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=86400',
    }),
    body: bytes,
  });
  if (!up.ok) {
    return res.status(502).json({
      erro: 'O Storage recusou a imagem.',
      status: up.status,
      detalhe: await up.text().catch(() => null),
    });
  }

  const url = SB_URL + '/storage/v1/object/public/' + BUCKET + '/' + caminho;

  // ---- A URL e publica DE VERDADE? ---------------------------------------
  // Se o bucket nao for publico a Meta nao baixa a imagem, o envio falha e a
  // gente so descobre com o disparo perdido. Conferir aqui custa 200 ms.
  let checagem = null;
  try {
    const t = await fetch(url, { headers: { Range: 'bytes=0-2' } });
    checagem = { status: t.status, tipo: t.headers.get('content-type') };
    if (!t.ok || !/^image\//.test(checagem.tipo || '')) {
      return res.status(502).json({
        erro: 'A imagem subiu mas a URL publica nao devolve imagem. Nao vou gravar.',
        url, resposta: checagem,
      });
    }
  } catch (e) {
    return res.status(502).json({ erro: 'Nao consegui conferir a URL publica.', url });
  }

  // ---- Grava a linha do dia ----------------------------------------------
  // data_ref tem indice unico: o ultimo cardapio publicado no dia sobrescreve.
  const gr = await fetch(SB_URL + '/rest/v1/cardapio_dia?on_conflict=data_ref', {
    method: 'POST',
    headers: cabecalhosSB({
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    body: JSON.stringify([{
      data_ref: dia,
      pratos,
      destaques: Array.isArray(corpo.destaques) ? corpo.destaques : null,
      enviado_por: String(corpo.aprovado_por || 'api').slice(0, 60),
      urls_artes: { principal: url },
      recebido_em: new Date().toISOString(),
    }]),
  });
  const gravado = await gr.json().catch(() => null);
  if (!gr.ok) {
    return res.status(502).json({ erro: 'A imagem subiu mas a linha nao gravou.', url, detalhe: gravado });
  }

  return res.status(200).json({
    ok: true,
    data_ref: dia,
    pratos: pratos.length,
    url,
    imagem: { bytes: bytes.length, tipo: checagem.tipo },
    bucket_criado_agora: b.criado,
    aviso: 'Publicado. O /api/campanha das 10h vai usar esta arte em vez da rotacao. '
      + 'Nada foi enviado por aqui.',
  });
};
