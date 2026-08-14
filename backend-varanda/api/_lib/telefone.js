// Normalização de telefone do Varanda.
// Os relatórios do Nomos vêm SEM DDD. O DDD do Varanda é 44.
// Esta lógica é a mesma já validada por 11 testes automatizados no painel da aba 1.

function normalizarTelefone(bruto) {
  let d = String(bruto || '').replace(/\D/g, '');

  if (!d) {
    return { ok: false, motivo: 'vazio', e164: '', display: '' };
  }

  // Remove o 55 se já vier no formato internacional
  if (d.length >= 12 && d.startsWith('55')) {
    d = d.slice(2);
  }

  let ddd;
  let numero;
  let obs = '';

  if (d.length === 8 || d.length === 9) {
    // Vem sem DDD (caso padrão do Nomos)
    ddd = '44';
    numero = d;
    obs = 'DDD 44 assumido';
  } else if (d.length === 10 || d.length === 11) {
    ddd = d.slice(0, 2);
    numero = d.slice(2);
  } else {
    return {
      ok: false,
      motivo: 'quantidade de dígitos estranha (' + d.length + ')',
      e164: '',
      display: String(bruto),
    };
  }

  // Celular brasileiro tem 9 dígitos. Com 8, provavelmente falta o nono.
  // Não recusamos de imediato: fixos legítimos (como o próprio 2090-0707) têm 8.
  if (numero.length === 8) {
    return {
      ok: true,
      alerta: '8 dígitos (fixo ou falta o 9?)',
      e164: '+55' + ddd + numero,
      display: '(' + ddd + ') ' + numero.slice(0, 4) + '-' + numero.slice(-4),
      obs,
    };
  }

  return {
    ok: true,
    e164: '+55' + ddd + numero,
    display:
      '(' + ddd + ') ' + numero.slice(0, numero.length - 4) + '-' + numero.slice(-4),
    obs,
  };
}

module.exports = { normalizarTelefone };
