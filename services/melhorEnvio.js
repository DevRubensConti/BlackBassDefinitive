// services/melhorEnvio.js
const fetch = require('node-fetch'); // ou global fetch no Node 18+

const BASE_URL = process.env.MELHOR_ENVIO_BASE_URL || 'https://sandbox.melhorenvio.com.br';
const AUTH_URL = process.env.MELHOR_ENVIO_AUTH_URL || BASE_URL;
const CLIENT_ID = process.env.MELHOR_ENVIO_CLIENT_ID;
const CLIENT_SECRET = process.env.MELHOR_ENVIO_CLIENT_SECRET;
const REDIRECT_URI = process.env.MELHOR_ENVIO_REDIRECT_URI;

// URL para onde você vai mandar o usuário autorizar
function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'shipping-calculate shipping-read shipping-write', // ajustar escopos conforme docs
    state: state || ''
  });
  return `${AUTH_URL}/oauth/authorize?${params.toString()}`;
}

// Troca "code" por access_token
async function exchangeCodeForToken(code) {
  const resp = await fetch(`${AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Erro ao trocar code por token: ${resp.status} - ${txt}`);
  }

  return resp.json(); // { access_token, refresh_token, expires_in, ... }
}

// Refresh token (pra quando expirar)
async function refreshToken(refreshToken) {
  const resp = await fetch(`${AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Erro ao renovar token: ${resp.status} - ${txt}`);
  }

  return resp.json();
}

// Chamada genérica autenticada
async function melhorEnvioRequest(path, accessToken, options = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...options.headers
  };

  const resp = await fetch(url, { ...options, headers });
  const text = await resp.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!resp.ok) {
    throw new Error(`Erro MelhorEnvio ${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshToken,
  melhorEnvioRequest
};
