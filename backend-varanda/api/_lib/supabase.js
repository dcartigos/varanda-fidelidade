// Acesso ao Supabase pelo servidor, usando a service_role.
// A service_role IGNORA as políticas de RLS — por isso ela só pode existir aqui,
// como variável de ambiente do Vercel. NUNCA no navegador, nunca em HTML.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supabaseConfigurado() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE);
}

/**
 * Insere linhas numa tabela via API REST do Supabase.
 * Retorna { ok, dados, erro }. Nunca lança — o webhook não pode quebrar
 * por causa de falha de banco, senão a YCloud fica reenviando o evento.
 */
async function inserir(tabela, linhas, opcoes = {}) {
  if (!supabaseConfigurado()) {
    return { ok: false, erro: 'Supabase não configurado (faltam variáveis de ambiente)' };
  }

  const cabecalhos = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  // Usado para idempotência: em conflito de chave única, não duplica.
  if (opcoes.ignorarDuplicados) {
    cabecalhos.Prefer = 'return=representation,resolution=ignore-duplicates';
  }

  try {
    const resposta = await fetch(
      SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + tabela,
      {
        method: 'POST',
        headers: cabecalhos,
        body: JSON.stringify(Array.isArray(linhas) ? linhas : [linhas]),
      }
    );

    const texto = await resposta.text();
    let dados = null;
    try {
      dados = texto ? JSON.parse(texto) : null;
    } catch (_) {
      dados = texto;
    }

    if (!resposta.ok) {
      return { ok: false, status: resposta.status, erro: dados };
    }
    return { ok: true, dados };
  } catch (e) {
    return { ok: false, erro: String(e && e.message ? e.message : e) };
  }
}

/**
 * Verifica se uma chave de idempotência já foi usada.
 * Retorna true se JÁ EXISTE (ou seja, não deve enviar de novo).
 */
async function chaveJaUsada(chave) {
  if (!supabaseConfigurado() || !chave) return false;

  try {
    const url =
      SUPABASE_URL.replace(/\/$/, '') +
      '/rest/v1/envios_idempotencia?chave=eq.' +
      encodeURIComponent(chave) +
      '&select=chave&limit=1';

    const resposta = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE,
      },
    });

    if (!resposta.ok) return false; // em dúvida, não bloqueia o envio
    const dados = await resposta.json();
    return Array.isArray(dados) && dados.length > 0;
  } catch (_) {
    return false;
  }
}

module.exports = { supabaseConfigurado, inserir, chaveJaUsada };
