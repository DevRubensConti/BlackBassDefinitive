const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const MP_BASE_URL = 'https://api.mercadopago.com';
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();

// 🔹 Opcional, mas ajuda o teste do painel a não dar 404
router.get('/webhooks/mercadopago', (req, res) => {
  console.log('[WEBHOOK MP] GET de teste recebido:', req.query);
  return res.sendStatus(200);
});

// 🔹 Aqui fica o POST real, usado pelas notificações de verdade
router.post('/webhooks/mercadopago', async (req, res) => {
  try {
    console.log('[WEBHOOK MP] Recebido:', req.query, req.body);

    // Primeira tentativa: id na query
    let preapprovalId = req.query.id;

    // Segunda tentativa: id como "data.id" na query
    if (!preapprovalId && req.query['data.id']) {
      preapprovalId = req.query['data.id'];
    }

    // Terceira tentativa: id no body (muito comum em prod)
    if (!preapprovalId && req.body?.data?.id) {
      preapprovalId = req.body.data.id;
    }

    if (!preapprovalId) {
      console.warn('[WEBHOOK MP] Nenhum preapprovalId encontrado.');
      return res.sendStatus(200);
    }

    console.log('[WEBHOOK MP] PreapprovalID detectado:', preapprovalId);

    // Agora sim consulta a API
    const url = `${MP_BASE_URL}/preapproval/${preapprovalId}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
    });

    const subs = await resp.json();
    console.log('[WEBHOOK MP] Dados do preapproval:', subs);

    if (subs && subs.id) {
      await supabaseDb
        .from('assinaturas')
        .update({
          status: subs.status,
          raw_payload: subs,
          updated_at: new Date().toISOString()
        })
        .eq('mp_preapproval_id', subs.id);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK MP] Erro:', e);
    return res.sendStatus(500);
  }
});


module.exports = router;
