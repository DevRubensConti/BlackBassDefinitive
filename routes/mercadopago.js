// routes/mercadopago.js
const express = require('express');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const router = express.Router();

// Cria o cliente do Mercado Pago com o access token
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

// 🔹 Cria a preferência e redireciona para o Checkout Pro
router.post('/create-preference', async (req, res) => {
  try {
    const preference = new Preference(mpClient);

    const result = await preference.create({
      body: {
        items: [
          { title: 'Produto teste', quantity: 1, unit_price: 100 }
        ],
        back_urls: {
          success: 'https://blackbass-marketplace.onrender.com/api/checkout/sucesso',
          failure: 'https://blackbass-marketplace.onrender.com/api/checkout/erro',
          pending: 'https://blackbass-marketplace.onrender.com/api/checkout/pendente'
        },
        auto_return: 'approved',
        notification_url: 'https://blackbass-marketplace.onrender.com/api/checkout/webhook'
      }
    });

    const { init_point, sandbox_init_point } = result;
    return res.redirect(init_point || sandbox_init_point);
  } catch (error) {
    console.error('Erro ao criar preferência:', error);
    return res.status(500).send('Erro ao criar preferência');
  }
});

// 🔔 Webhook (já tem o express.raw no app.js antes dos parsers)
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.get('x-signature');
    const requestId = req.get('x-request-id');

    console.log('📨 Webhook MP recebido:', {
      signature,
      requestId,
      rawLength: req.body?.length
    });

    // TODO: validar assinatura e tratar eventos
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

module.exports = router;
