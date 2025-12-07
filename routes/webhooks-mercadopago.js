const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const MP_BASE_URL = 'https://api.mercadopago.com';
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();

router.post('/webhooks/mercadopago', async (req, res) => {
  try {
    const { type, id, topic } = req.query;

    if (!id) {
      console.warn('[WEBHOOK MP] Chamada sem id na query:', req.query);
      return res.sendStatus(200); // não quebra o webhook
    }

    // Assinaturas (preapproval)
    if (type === 'preapproval' || topic === 'preapproval') {
      const url = `${MP_BASE_URL}/preapproval/${id}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`
        }
      });

      const subs = await resp.json();
      console.log('[WEBHOOK MP] preapproval recebido:', subs.id, subs.status);

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
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[WEBHOOK MP] Erro:', e);
    res.sendStatus(500);
  }
});

module.exports = router;
