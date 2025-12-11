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
      console.error('[SUBS] Plano não encontrado:', { planoId, error });
      return res.status(404).send('Plano não encontrado');
    }

    console.log('[SUBS][VIEW] Render assinatura', {
      userId: usr.id,
      planoId,
      mp_plan_id: plano.mp_plan_id,
      preco_cents: plano.preco_cents
    });

    return res.render('assinatura', {
      usuario: usr,
      plano,
      MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY
    });
  } catch (e) {
    console.error('[SUBS] Erro ao carregar página de assinatura:', e);
    return res.status(500).send('Erro ao carregar página de assinatura.');
  }
});

// POST /assinaturas/subscribe-brick -> recebe token do cartão e cria assinatura
router.post('/assinaturas/subscribe-brick', requireLogin, async (req, res) => {
  try {
    const usuario = req.session.usuario;
    const { planoId, cardTokenId, payerEmail } = req.body;

    console.log('[SUBS][POST] Body recebido:', {
      planoId,
      cardTokenId: cardTokenId ? '***' : null,
      payerEmail,
      usuarioId: usuario?.id
    });

    if (!planoId || !cardTokenId || !payerEmail) {
      return res.status(400).json({
        ok: false,
        error: 'Dados incompletos para assinatura (planoId, cardTokenId, payerEmail).'
      });
    }

    // 1) Carrega o plano
    const { data: plano, error: planoErr } = await supabaseDb
      .from('planos_assinatura')
      .select('*')
      .eq('id', planoId)
      .maybeSingle();

    if (planoErr || !plano) {
      console.error('[SUBS] Plano não encontrado no POST:', { planoId, planoErr });
      return res.status(400).json({ ok: false, error: 'Plano não encontrado.' });
    }

    // 2) Cria preapproval no Mercado Pago
    const mpSubs = await criarAssinaturaComCardToken({
      plano,
      cardTokenId,
      payerEmail,
      usuarioId: usuario.id
    });

    // 3) Salva assinatura no Supabase
    const insertPayload = {
      usuario_id: usuario.id,
      plano_id: plano.id,
      mp_preapproval_id: mpSubs.id,
      status: mpSubs.status || 'authorized',
      valor_cents: plano.preco_cents,
      created_at: new Date().toISOString()
    };

    console.log('[SUBS] Salvando assinatura no Supabase:', insertPayload);

    const { data: novaAssinatura, error: dbErr } = await supabaseDb
      .from('assinaturas')
      .insert(insertPayload)
      .select('*')
      .maybeSingle();

    if (dbErr) {
      console.error('[SUBS] Erro salvando assinatura no Supabase:', dbErr);
      return res.status(500).json({
        ok: false,
        error: 'Erro ao salvar assinatura no banco.'
      });
    }

    // 4) Responde pro front
    return res.json({
      ok: true,
      assinatura: novaAssinatura,
      mp_status: mpSubs.status
    });
  } catch (e) {
    console.error('[SUBS] Erro geral subscribe-brick:', e);
    return res.status(500).json({
      ok: false,
      error: e.message || 'Erro ao processar assinatura.'
    });
  }
});

module.exports = router;
