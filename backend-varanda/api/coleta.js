
    return responder(res, 200, {
      ok: true, completa: true, pode_enviar: podeEnviar,
      proximo_passo: podeEnviar
        ? 'Chamar /api/rotina-diaria com &seco=1 para conferir, e depois sem o seco=1 para enviar.'
        : 'coleta_confiavel() deu false. NÃO chame a rotina. Avise o Lucas.',
      despesas_gravadas: !!s.despesas_gravadas,
    });
  }

  // -------------------------------------------------------------- FECHAR LOG
  if (acao === 'fechar_log') {
    const id = Number(c.execucao_id);
    if (!id) return responder(res, 400, { erro: 'execucao_id é obrigatório.' });
    await sb('/execucoes_log?id=eq.' + id, {
      method: 'PATCH',
      body: JSON.stringify({
        terminado_em: new Date().toISOString(),
        sucesso: c.sucesso !== false,
        detalhe: c.detalhe || null,
        mensagem: limpar(c.mensagem) || null,
      }),
    });
    return responder(res, 200, { ok: true });
  }

  return responder(res, 400, {
    erro: 'Ação desconhecida: ' + (acao || '(vazia)'),
    acoes: ['inicio', 'pedidos', 'pontos', 'buffet', 'despesas', 'ifood', 'concluir', 'fechar_log'],
  });
};
