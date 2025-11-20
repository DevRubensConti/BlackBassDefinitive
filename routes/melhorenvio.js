// routes/melhorenvio.js
const express = require('express');
const supabaseDb = require('../supabase/supabaseDb');
const {
  buildAuthorizeUrl,
  exchangeCodeForToken
} = require('../services/melhorEnvio');

const router = express.Router();

/**
 * GET /integracoes/melhorenvio/connect
 * Inicia o fluxo OAuth do Melhor Envio.
 * O vendedor precisa estar logado e possuir uma loja criada.
 */
router.get('/integracoes/melhorenvio/connect', async (req, res) => {
  try {
    const usr = req.session?.usuario || {};

    if (!usr.id) {
      return res.redirect('/login');
    }

    // Busca a loja cadastrada para este vendedor
    const { data: loja, error: lojaErr } = await supabaseDb
      .from('lojas')
      .select('id')
      .eq('usuario_id', usr.id)
      .maybeSingle();

    if (lojaErr || !loja) {
      console.error('[ME][CONNECT] Usuário não possui loja cadastrada:', lojaErr);
      return res.status(400).send('Você precisa criar sua loja antes de conectar com o Melhor Envio.');
    }

    const lojaId = loja.id;

    // Gera STATE seguro contendo loja_id
    const state = `${lojaId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    req.session.me_state = state;

    // Monta URL de autorização
    const url = buildAuthorizeUrl(state);
    return res.redirect(url);

  } catch (err) {
    console.error('[ME][CONNECT] EXCEPTION:', err);
    return res.status(500).send('Erro ao iniciar integração com Melhor Envio.');
  }
});


/**
 * GET /integracoes/melhorenvio/callback
 * Endpoint configurado como Redirect URI no painel do Melhor Envio.
 * Recebe ?code= e troca por tokens.
 */
router.get('/integracoes/melhorenvio/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error('[ME][CALLBACK] Erro recebido do Melhor Envio:', { error, error_description });
      return res.status(400).send('Erro ao autorizar sua conta no Melhor Envio.');
    }

    if (!code) {
      return res.status(400).send('Code não informado pelo Melhor Envio.');
    }

    // validação de STATE
    if (!state || state !== req.session.me_state) {
      console.warn('[ME][CALLBACK] STATE INVÁLIDO:', {
        recebido: state,
        esperado: req.session.me_state
      });
      return res.status(400).send('State inválido. Processo cancelado por segurança.');
    }

    // extrai loja_id do STATE
    const [lojaId] = state.split(':');

    if (!lojaId) {
      return res.status(400).send('Loja inválida no state.');
    }

    // troca o CODE por tokens
    const tokenData = await exchangeCodeForToken(code);

    if (!tokenData?.access_token) {
      console.error('[ME][CALLBACK] Token inválido recebido:', tokenData);
      return res.status(400).send('Falha ao obter token do Melhor Envio.');
    }

    // salva os tokens no banco (um registro por loja)
    const { error: upsertErr } = await supabaseDb
      .from('melhorenvio_tokens')
      .upsert(
        {
          loja_id: lojaId,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          token_type: tokenData.token_type || 'Bearer',
          created_at: new Date().toISOString()
        },
        { onConflict: 'loja_id' }
      );

    if (upsertErr) {
      console.error('[ME][CALLBACK] Erro salvando token no Supabase:', upsertErr);
      return res.status(500).send('Erro ao salvar token do Melhor Envio.');
    }

    console.log('[ME][CALLBACK] Token salvo para loja:', lojaId);

    // Após integrar, redireciona para painel/vendedor
    return res.redirect('/painel/loja?me_integrado=1');

  } catch (err) {
    console.error('[ME][CALLBACK] EXCEPTION', err);
    return res.status(500).send('Erro interno ao finalizar integração com Melhor Envio.');
  }
});

module.exports = router;
