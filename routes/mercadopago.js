// routes/mercadopago.js
// Integração Checkout Pro (SDK v2) + retorno JSON para o front (checkout.ejs)

const express = require('express');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const router = express.Router();

// Cria o cliente do Mercado Pago com o access token do ambiente
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

// Util para descobrir ambiente só p/ metadata/debug
function getEnvFromToken(token) {
  return (token || '').startsWith('TEST-') ? 'SANDBOX' : 'PRODUCAO';
}

// 🔹 POST /api/checkout/create-preference
// Recebe { items, buyer, debug? } do checkout.ejs e devolve { init_point }
router.post('/create-preference', async (req, res) => {
  try {
    const { items, buyer, debug } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio.' });
    }

    const normItems = items.map(it => ({
      title: String(it.title || 'Item'),
      quantity: Number(it.quantity || 1),
      unit_price: Number(it.unit_price || 0),
      currency_id: it.currency_id || 'BRL'
    })).filter(x => x.quantity > 0 && x.unit_price >= 0);

    const env = getEnvFromToken(process.env.MP_ACCESS_TOKEN);

    // ⚠️ Em produção, deixe o MP coletar o CPF no próprio checkout.
    // Envie apenas nome/email para pré-preencher.
    const payer = {
      name: (buyer && buyer.name) || 'Cliente',
      email: (buyer && buyer.email) || 'cliente@example.com'
      // NÃO enviar identification aqui (CPF será coletado pelo MP no Checkout Pro)
    };

    const preference = new Preference(mpClient);

    const body = {
      items: normItems,
      back_urls: {
        success: 'https://blackbass-marketplace.onrender.com/api/checkout/sucesso',
        failure: 'https://blackbass-marketplace.onrender.com/api/checkout/erro',
        pending: 'https://blackbass-marketplace.onrender.com/api/checkout/pendente'
      },
      auto_return: 'approved',
      notification_url: 'https://blackbass-marketplace.onrender.com/api/checkout/webhook',
      statement_descriptor: 'BLACKBASS',
      payer,
      metadata: {
        buyerEmail: payer.email,
        mp_env: env,
        debug_ts: new Date().toISOString()
      }
    };

    // 🌶️ LOG COMPLETO DE ENTRADA
    console.log('[MP][CREATE_PREF] IN', {
      env,
      tokenPrefix: String(process.env.MP_ACCESS_TOKEN || '').slice(0, 10) + '…',
      items: normItems,
      payer,
      ip: req.ip,
      ua: req.get('user-agent')
    });

    const result = await preference.create({ body });

    // 🌶️ LOG COMPLETO DE SAÍDA
    console.log('[MP][CREATE_PREF] OUT', {
      id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      date_created: result.date_created,
      live_mode: result.live_mode // true=produção, false=sandbox
    });

    const initPoint = result.init_point || result.sandbox_init_point;
    if (!initPoint) {
      console.error('[MP][CREATE_PREF] Sem init_point:', result);
      return res.status(500).json({ error: 'Sem init_point retornado pelo MP.' });
    }

    // 👉 Se vier debug=true no body, devolve TUDO pra inspecionar no navegador
    if (debug) {
      return res.json({ init_point: initPoint, result, request_body: body });
    }

    // Normal: devolve só o link pro front redirecionar
    return res.json({ init_point: initPoint });

  } catch (error) {
    console.error('[MP][CREATE_PREF] ERROR', error);
    return res.status(500).json({ error: 'Erro ao criar preferência', details: String(error?.message || error) });
  }
});


// 🔔 Webhook (você já setou express.raw no app.js antes dos parsers)
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.get('x-signature');
    const requestId = req.get('x-request-id');

    console.log('📨 Webhook MP recebido:', {
      signature,
      requestId,
      rawLength: req.body?.length
    });

    // TODO: validar assinatura e tratar evento PAYMENT/MERCHANT_ORDER etc.
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err);
    return res.status(500).send('Erro no webhook');
  }
});

// ✅ Páginas de retorno
router.get('/sucesso', (req, res) => res.render('sucesso'));
router.get('/pendente', (req, res) => res.render('pendente'));
router.get('/erro', (req, res) => res.render('erro'));

// 🔎 Rota de debug do ambiente/token
router.get('/debug', (req, res) => {
  const token = process.env.MP_ACCESS_TOKEN || '';
  const mode = getEnvFromToken(token); // 'SANDBOX' | 'PRODUCAO'
  res.json({
    mode,
    tokenPrefix: token.slice(0, 10) + '…',
    now: new Date().toISOString()
  });
});

module.exports = router;
