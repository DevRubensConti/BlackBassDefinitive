const express = require('express');
const router = express.Router();
const { createPreference, handleWebhook, mpClient } = require('../controllers/mercadopagoController');
const { Payment } = require('mercadopago');

// ======================================
// API: Checkout (usado pelo frontend)
// ======================================

// Cria preferência (botão do checkout chama este endpoint)
router.post('/create-preference', createPreference);

// Webhook (notificações automáticas do Mercado Pago)
router.post('/webhook', express.raw({ type: '*/*' }), handleWebhook);

// ======================================
// Rotas de retorno (back_urls)
// ======================================

router.get('/sucesso', (req, res) => {
  const { payment_id, status, preference_id } = req.query;
  res.render('sucesso', { 
    titulo: 'Pagamento aprovado ✅',
    payment_id,
    status,
    preference_id
  });
});

router.get('/pendente', (req, res) => {
  res.render('pendente', { titulo: 'Pagamento pendente ⏳' });
});

router.get('/erro', (req, res) => {
  res.render('erro', { titulo: 'Pagamento não concluído ❌' });
});

// ======================================
// Nova rota: Diagnóstico / Resultado
// (mostra status_detail e detalhes do pagamento)
// ======================================

router.get('/resultado', async (req, res) => {
  try {
    const { payment_id, status, preference_id } = req.query;

    if (!payment_id) {
      return res.status(400).send('Nenhum payment_id informado.');
    }

    const payment = await new Payment(mpClient).get({ id: payment_id });

    const info = {
      id: payment.id,
      status: payment.status,
      status_detail: payment.status_detail, // ⚠️ Motivo exato da aprovação/rejeição
      payment_method: payment.payment_method_id,
      description: payment.description,
      transaction_amount: payment.transaction_amount,
      payer_email: payment.payer?.email,
      external_reference: payment.external_reference
    };

    console.log('🔍 Pagamento consultado:', info);

    // Renderiza um resultado amigável (ou JSON, se preferir)
    res.status(200).send(`
      <h1>Resultado do Pagamento</h1>
      <pre>${JSON.stringify(info, null, 2)}</pre>
      <a href="/">Voltar</a>
    `);

  } catch (err) {
    console.error('Erro ao consultar pagamento:', err);
    res.status(500).send('Erro ao consultar pagamento.');
  }
});

// ======================================
module.exports = router;
