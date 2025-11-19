// routes/melhorenvio.js
const express = require('express');
const supabaseDb = require('../supabase/supabaseDb');
const {
  buildAuthorizeUrl,
  exchangeCodeForToken
} = require('../services/melhorEnvio');

const router = express.Router();

// GET /integracoes/melhorenvio/connect
// (você pode deixar escondido e usar só na área do vendedor)
router.get('/integracoes/melhorenvio/connect', (req, res) => {
  const usr = req.session?.usuario || {};
  if (!usr.id) return res.redirect('/login');

  // state simples: id do usuário + algo randômico
  const state = `${usr.id}:${Date.now()}`;
  req.session.me_state = state;

  const url = buildAuthorizeUrl(state);
  return res.redirect(url);
});

// Callback configurado no painel do Melhor Envio
router.get('/integracoes/melhorenvio/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    const usr = req.session?.usuario || {};

    if (!usr.id) return res.redirect('/login');

    if (error) {
      console.error('[ME][CALLBACK] erro na autorização:', error, error_description);
      return res.status(400).send('Erro ao autorizar Melhor Envio.');
    }

    if (!code) {
      return res.status(400).send('Code não informado.');
    }

    // opcional: validar state
    if (!state || state !== req.session.me_state) {
      console.warn('[ME][CALLBACK] state inválido', { state, sessionState: req.session.me_state });
      // não bloqueio, mas em prod é bom checar melhor
    }

    const tokenData = await exchangeCodeForToken(code);
    /*
      tokenData ~ {
        access_token,
        refresh_token,
        expires_in,
        token_type,
        created_at
      }
    */

    // salva no supabase em uma tabela tipo "melhorenvio_tokens"
    const { error: upsertErr } = await supabaseDb
      .from('melhorenvio_tokens')
      .upsert({
        usuario_id: usr.id,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        token_type: tokenData.token_type || 'Bearer',
        created_at: new Date().toISOString()
      }, { onConflict: 'usuario_id' });

    if (upsertErr) {
      console.error('[ME][CALLBACK] erro ao salvar token no Supabase:', upsertErr);
      return res.status(500).send('Erro ao salvar autorização do Melhor Envio.');
    }

    return res.redirect('/painel/loja?me_integrado=1'); // ou onde fizer sentido
  } catch (err) {
    console.error('[ME][CALLBACK] EXCEPTION', err);
    return res.status(500).send('Erro interno na integração com Melhor Envio.');
  }
});

module.exports = router;
