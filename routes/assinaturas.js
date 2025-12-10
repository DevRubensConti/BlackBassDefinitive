// routes/assinaturas.js
const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { requireLogin } = require('../middlewares/auth');
const { criarAssinaturaComCardToken } = require('../services/mercadoPagoAssinaturas');

// GET /assinaturas/:planoId -> exibe a tela com o Brick
router.get('/assinaturas/:planoId', requireLogin, async (req, res) => {
  try {
    const usr = req.session.usuario;
    const planoId = req.params.planoId;

    const { data: plano, error } = await supabaseDb
      .from('planos_assinatura')
      .select('*')
      .eq('id', planoId)
      .maybeSingle();

    if (error || !plano) {
      console.error('[SUBS] Plano não encontrado:', error);
      return res.status(404).send('Plano não encontrado');
    }

    return res.render('assinatura', {
      usuario: usr,
      plano,
      MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY
    });
  } catch (e) {
    console.error('[SUBS] Erro GET /assinaturas/:planoId', e);
    return res.status(500).send('Erro ao carregar página de assinatura.');
  }
});

/**
 * POST /assinaturas/subscribe-brick
 * Recebe dados do Payment Brick (card_token, email, planoId)
 * e cria a assinatura no Mercado Pago.
 */
router.post('/assinaturas/subscribe-brick', requireLogin, async (req, res) => {
  try {
    console.log('[SUBS][POST] Body recebido:', req.body);
    const usuario = req.session.usuario;
    const {
      planoId,
      cardTokenId,
      payerEmail
      // se quiser, também installments, paymentMethodId, issuerId, etc.
    } = req.body;

    if (!planoId || !cardTokenId || !payerEmail) {
      return res.status(400).json({ error: 'Dados incompletos para assinatura.' });
    }

    // 1) Carrega plano
    const { data: plano, error: planoErr } = await supabaseDb
      .from('planos_assinatura')
      .select('*')
      .eq('id', planoId)
      .maybeSingle();

    if (planoErr || !plano) {
      console.error('[SUBS] Plano não encontrado:', planoErr);
      return res.status(404).json({ error: 'Plano não encontrado.' });
    }

    if (!plano.mp_plan_id) {
      console.error('[SUBS] Plano sem mp_plan_id!');
      return res.status(500).json({ error: 'Plano sem integração Mercado Pago.' });
    }

    // 2) Verifica se já existe assinatura ativa para esse plano
    const { data: subAtiva } = await supabaseDb
      .from('assinaturas')
      .select('*')
      .eq('usuario_id', usuario.id)
      .eq('plano_id', plano.id)
      .in('status', ['authorized', 'active'])
      .maybeSingle();

    if (subAtiva) {
      return res.status(409).json({ error: 'Já existe assinatura ativa para este plano.' });
    }

    // 3) Cria assinatura no Mercado Pago
    const mpSubs = await criarAssinaturaComCardToken({
      plano,
      cardTokenId,
      payerEmail,
      usuarioId: usuario.id
    });

    // 4) Salva no Supabase
    const { data: novaAssinatura, error: insertErr } = await supabaseDb
      .from('assinaturas')
      .insert({
        usuario_id: usuario.id,
        plano_id: plano.id,
        mp_preapproval_id: mpSubs.id,
        status: mpSubs.status || 'pending',
        raw_payload: mpSubs
      })
      .select()
      .maybeSingle();

    if (insertErr) {
      console.error('[SUBS] Erro ao salvar assinatura no banco:', insertErr);
      return res.status(500).json({ error: 'Erro ao salvar assinatura.' });
    }

    // 5) Responde pro front
    return res.json({
      ok: true,
      assinatura: novaAssinatura,
      mp_status: mpSubs.status
    });
  } catch (e) {
    console.error('[SUBS] Erro geral subscribe-brick:', e);
    return res.status(500).json({ error: 'Erro ao processar assinatura.' });
  }
});

module.exports = router;
