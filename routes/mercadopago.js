// routes/mercadopago.js
// Rotas do Mercado Pago (Checkout Pro) para uso com CommonJS + Express

const express = require('express');
const mercadopago = require('mercadopago');

const router = express.Router();

// ⚙️ Configuração do SDK (token via variável de ambiente)
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

// 🔹 Cria a preferência e redireciona para o Checkout Pro
router.post('/create-preference', async (req, res) => {
  try {
    // TODO: opcional — montar itens a partir do seu carrinho/sessão
    const preference = {
      items: [
        {
          title: 'Produto teste',
          quantity: 1,
          unit_price: 100
        }
      ],
      back_urls: {
        success: 'https://blackbass-marketplace.onrender.com/api/checkout/sucesso',
        failure: 'https://blackbass-marketplace.onrender.com/api/checkout/erro',
        pending: 'https://blackbass-marketplace.onrender.com/api/checkout/pendente'
      },
      auto_return: 'approved',
      // Recomendo usar o webhook para receber atualizações assíncronas
      notification_url: 'https://blackbass-marketplace.onrender.com/api/checkout/webhook'
    };

const response = await mercadopago.preferences.create(preference);

const { init_point, sandbox_init_point } = response.body;
return res.redirect(init_point || sandbox_init_point);
  } catch (error) {
    console.error('Erro ao criar preferência:', error);
    return res.status(500).send('Erro ao criar preferência');
  }
});

// 🔔 Webhook (notificações do Mercado Pago)
// Observação: em app.js você já definiu express.raw() ANTES dos parsers para esta rota.
router.post('/webhook', async (req, res) => {
  try {
    // Headers úteis para validação e rastreio
    const signature = req.get('x-signature');
    const requestId = req.get('x-request-id');

    console.log('📨 Webhook MP recebido:', {
      signature,
      requestId,
      // req.body aqui é um Buffer porque você usou express.raw no app.js
      rawLength: req.body?.length
    });

    // TODO: validar assinatura (opcional, recomendado)
    // TODO: parse do Buffer e tratamento do evento (PAYMENT, MERCHANT_ORDER, etc.)

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err);
    return res.status(500).send('Erro no webhook');
  }
});

// ✅ Páginas de retorno (renderizam views EJS)
router.get('/sucesso', (req, res) => res.render('sucesso'));
router.get('/pendente', (req, res) => res.render('pendente'));
router.get('/erro', (req, res) => res.render('erro'));

module.exports = router;
