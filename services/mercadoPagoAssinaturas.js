const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const MP_BASE_URL = 'https://api.mercadopago.com';
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();

if (!MP_ACCESS_TOKEN) {
  console.warn('[MP][ASSINATURAS] ATENÇÃO: MP_ACCESS_TOKEN não definido!');
}

/**
 * Cria uma assinatura (preapproval) associada a um plano existente,
 * usando card_token_id gerado pelo Payment Brick.
 */
async function criarAssinaturaComCardToken({ plano, cardTokenId, payerEmail, usuarioId }) {
  const url = `${MP_BASE_URL}/preapproval`;

  const body = {
    preapproval_plan_id: plano.mp_plan_id,
    reason: plano.nome,
    card_token_id: cardTokenId,
    payer_email: payerEmail,
    status: 'authorized', // para plano associado, costuma ser 'authorized'
    external_reference: `user_${usuarioId}_plano_${plano.id}`
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await resp.json();

  if (!resp.ok) {
    console.error('[MP][ASSINATURA] Erro na criação:', resp.status, json);
    throw new Error(`Erro MP preapproval: ${resp.status}`);
  }

  return json; // contém id, status, etc.
}

module.exports = {
  criarAssinaturaComCardToken
};
