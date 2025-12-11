// services/mercadoPagoAssinaturas.js
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const MP_BASE_URL = 'https://api.mercadopago.com';
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();

if (!MP_ACCESS_TOKEN) {
  console.warn('[MP][ASSINATURAS] ATENÇÃO: MP_ACCESS_TOKEN não definido!');
}

/**
 * Cria uma assinatura (preapproval) usando card_token_id gerado pelo Payment Brick.
 * Aqui eu NÃO dependo de preapproval_plan_id (mp_plan_id); uso auto_recurring direto
 * com valor e periodicidade do plano.
 */
async function criarAssinaturaComCardToken({ plano, cardTokenId, payerEmail, usuarioId }) {
  const url = `${MP_BASE_URL}/preapproval`;

  // Mapeia periodicidade do seu plano para o formato do MP
  let frequency = 1;
  let frequency_type = 'months'; // default

  switch ((plano.periodicidade || '').toLowerCase()) {
    case 'monthly':
    case 'mensal':
      frequency = 1;
      frequency_type = 'months';
      break;
    case 'weekly':
    case 'semanal':
      frequency = 1;
      frequency_type = 'days'; // 1 dia -> semanal você pode ajustar pra 7 se quiser
      break;
    default:
      frequency = 1;
      frequency_type = 'months';
  }

  const transactionAmount = (plano.preco_cents || 0) / 100;

  const body = {
    reason: plano.nome || 'Assinatura BlackBass',
    external_reference: `user_${usuarioId}_plano_${plano.id}`,
    payer_email: payerEmail,
    card_token_id: cardTokenId,
    auto_recurring: {
      frequency,
      frequency_type,      // 'days' | 'months'
      transaction_amount: transactionAmount,
      currency_id: 'BRL'
    },
    back_url: process.env.MP_SUBSCRIPTIONS_BACK_URL || 'https://blackbass-marketplace.onrender.com/minha-conta',
    status: 'authorized'
  };

  console.log('[MP][ASSINATURA] Enviando preapproval para MP:', {
    url,
    body
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`
    },
    body: JSON.stringify(body)
  });

  const json = await resp.json();

  console.log('[MP][ASSINATURA] Resposta MP:', resp.status, json);

  if (!resp.ok) {
    console.error('[MP][ASSINATURA] Erro na criação:', resp.status, json);
    throw new Error(`Erro MP preapproval: ${resp.status} - ${json.message || json.error || 'desconhecido'}`);
  }

  return json; // contém id, status, etc.
}

module.exports = {
  criarAssinaturaComCardToken
};
