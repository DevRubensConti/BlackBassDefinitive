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
// Recebe { items, buyer } do checkout.ejs e devolve { init_point }
router.post('/create-preference', async (req, res) => {
  try {
    const { items, buyer } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio.' });
    }

    // Normaliza itens vindos do front
    // (Checkout Pro aceita currency_id por item; manteremos BRL)
    const normItems = items.map(it => ({
      title: String(it.title || 'Item'),
      quantity: Number(it.quantity || 1),
      unit_price: Number(it.unit_price || 0),
      currency_id: it.currency_id || 'BRL'
    })).filter(x => x.quantity > 0 && x.unit_price >= 0);

    if (!normItems.length) {
      return res.status(400).json({ error: 'Itens inválidos.' });
    }

    // Payer básico (opcional, ajuda no preenchimento do MP)
    const payer = {
      name: (buyer && buyer.name) || 'Cliente',
      email: (buyer && buyer.email) || 'teste@example.com',
      // Identificação opcional (útil para boleto/Pix no BR)
      // Se quiser forçar um CPF de teste padrão:
      identification: {
        type: 'CPF',
        number: process.env.MP_DEFAULT_CPF || '12345678909'
      }
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
      payer,
      statement_descriptor: 'BLACKBASS',
      metadata: {
        buyerEmail: payer.email,
        mp_env: getEnvFromToken(process.env.MP_ACCESS_TOKEN)
      }
    };

    const result = await preference.create({ body });

    // Para SDK v2, ambos podem existir; priorize o de produção, senão sandbox
    const initPoint = result.init_point || result.sandbox_init_point;
    if (!initPoint) {
      console.error('Preferência criada sem init_point:', result);
      return res.status(500).json({ error: 'Sem init_point retornado pelo MP.' });
    }

    // 🔙 Retorna JSON (o seu front faz window.location.assign(init_point))
    return res.json({ init_point: initPoint });

  } catch (error) {
    console.error('Erro ao criar preferência:', error);
    return res.status(500).json({ error: 'Erro ao criar preferência' });
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

module.exports = router;
