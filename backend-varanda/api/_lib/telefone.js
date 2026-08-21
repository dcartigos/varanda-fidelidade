// Normalização de telefone do Varanda.
// Os relatórios do Nomos vêm SEM DDD. O DDD do Varanda é 44.
//
// ⚠️ BUG CORRIGIDO EM 20/08/2026 — LEIA ANTES DE MEXER
//
// A versão anterior, com 8 dígitos, devolvia `ok: true` e um `alerta` de texto,
// montando um E.164 de 12 dígitos (ex: +554499691829). NINGUÉM checava esse
// alerta. Resultado: a Meta ACEITAVA a mensagem, respondia `sent`, e nunca
// entregava. Não gerava 131026 nem 131047 — ficava parado num estado que parece
// bom para sempre.
//
// Foi assim que o relatório de fechamento "saiu" para o número do Lucas em
// +554499691829 e nunca chegou. Correlação medida no banco em 20/08:
//   13 dígitos -> delivered.   12 dígitos -> sent eterno.   Sem exceção.
//
// REGRA DO NONO DÍGITO (ANATEL): celular brasileiro tem 9 dígitos e começa com
// 9. Os antigos de 8 dígitos começavam com 6, 7, 8 ou 9. Fixo começa com 2, 3,
// 4 ou 5 e continua com 8 dígitos — e fixo não recebe WhatsApp.
//
// Portanto:
//   8 dígitos começando com 6/7/8/9 -> falta o nono, adicionar '9'
//   8 dígitos começando com 2/3/4/5 -> é fixo, NÃO serve para WhatsApp
//
// Todo E.164 que sair daqui com ok:true tem 13 dígitos. Isso é verificado no
// fim da função, e não é opcional.

function normalizarTelefone(bruto) {
    let d = String(bruto || '').replace(/\D/g, '');

  if (!d) {
        return { ok: false, motivo: 'vazio', e164: '', display: '' };
  }

  // 0800 do iFood: mascarado por pedido, nunca é WhatsApp.
  // Já é filtrado no importar.js, mas fica aqui também: este arquivo é o único
  // ponto por onde todo telefone passa, então é o lugar certo para a trava.
  if (/^0?800/.test(d)) {
        return { ok: false, motivo: '0800 (iFood mascarado) — nunca é WhatsApp', e164: '', display: String(bruto) };
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

  // ---- O nono dígito -------------------------------------------------------
  if (numero.length === 8) {
        const primeiro = numero[0];

      if (/[2-5]/.test(primeiro)) {
              // Fixo. Não recusar seria pior: geraria mensagem fantasma.
          return {
                    ok: false,
                    motivo: 'telefone fixo (' + ddd + ' ' + numero + ') — não recebe WhatsApp',
                    e164: '',
                    display: '(' + ddd + ') ' + numero.slice(0, 4) + '-' + numero.slice(-4),
          };
      }

      if (/[6-9]/.test(primeiro)) {
              numero = '9' + numero;
              obs = (obs ? obs + ' · ' : '') + 'nono dígito adicionado';
      } else {
              return {
                        ok: false,
                        motivo: 'número de 8 dígitos começando com ' + primeiro + ' — não reconhecido',
                        e164: '',
                        display: String(bruto),
              };
      }
  }

  const e164 = '+55' + ddd + numero;

  // ---- TRAVA FINAL: 13 dígitos, sempre ------------------------------------
  // Se esta trava disparar, é bug de código, não dado ruim. Melhor recusar do
  // que devolver um número que a Meta aceita e nunca entrega.
  const digitos = e164.replace(/\D/g, '').length;
    if (digitos !== 13) {
          return {
                  ok: false,
                  motivo: 'E.164 saiu com ' + digitos + ' dígitos em vez de 13 (' + e164 + ')',
                  e164: '',
                  display: String(bruto),
          };
    }

  return {
        ok: true,
        e164,
        display:
                '(' + ddd + ') ' + numero.slice(0, numero.length - 4) + '-' + numero.slice(-4),
        obs,
  };
}

module.exports = { normalizarTelefone };
