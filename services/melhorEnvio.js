// services/melhorEnvio.js
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Lê e normaliza variáveis de ambiente
const CLIENT_ID     = (process.env.MELHOR_ENVIO_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.MELHOR_ENVIO_CLIENT_SECRET || '').trim();
const BASE_URL      = (process.env.MELHOR_ENVIO_BASE_URL || 'https://sandbox.melhorenvio.com.br').trim();
const AUTH_URL      = (process.env.MELHOR_ENVIO_AUTH_URL || 'https://sandbox.melhorenvio.com.br').trim();
const REDIRECT_URI  = (process.env.MELHOR_ENVIO_REDIRECT_URI || '').trim();
// 🔥 Agora o escopo vem da env, com default seguro
// ⚠️ Para cart/checkout/labels você provavelmente vai precisar de algo como:
// MELHOR_ENVIO_SCOPES="shipping-calculate shipping-cart shipping-manage"
const SCOPES        = (process.env.MELHOR_ENVIO_SCOPES || 'shipping-calculate').trim();

// DEBUG de configuração
console.log('[ME] CLIENT_ID        =', CLIENT_ID ? CLIENT_ID.slice(0, 6) + '…' : '(vazio)');
console.log('[ME] BASE_URL         =', BASE_URL);
console.log('[ME] AUTH_URL         =', AUTH_URL);
console.log('[ME] REDIRECT_URI     =', REDIRECT_URI || '(vazio)');
console.log('[ME] SCOPES           =', SCOPES || '(vazio)');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('[ME] Atenção: CLIENT_ID ou CLIENT_SECRET vazios. Verifique seu .env');
}
if (!REDIRECT_URI) {
  console.warn('[ME] Atenção: REDIRECT_URI não configurado no .env');
}

/**
 * Monta URL de autorização para redirecionar o vendedor
 */
function buildAuthorizeUrl(state) {
  const cleanAuth = AUTH_URL.replace(/\/+$/, '');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    // Escopos agora controlados por env (MELHOR_ENVIO_SCOPES)
    scope: SCOPES,
    state
  });

  const url = `${cleanAuth}/oauth/authorize?${params.toString()}`;
  console.log('[ME][AUTH_URL] URL de autorização gerada:', url);
  return url;
}

/**
 * Troca o "code" pelos tokens (access_token / refresh_token)
 */
async function exchangeCodeForToken(code) {
  const cleanAuth = AUTH_URL.replace(/\/+$/, '');
  const url = `${cleanAuth}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code
    // client_id/secret vão no header via Basic Auth
  });

  // Header Basic Auth conforme OAuth2
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  console.log('[ME][TOKEN] Fazendo POST para', url);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`
    },
    body
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error('[MELHOR_ENVIO][TOKEN] ERROR', resp.status, data);
    throw new Error(
      data.error_description ||
        data.message ||
        `Erro ao obter token (status ${resp.status})`
    );
  }

  console.log('[MELHOR_ENVIO][TOKEN] OK', {
    hasAccess: !!data.access_token,
    hasRefresh: !!data.refresh_token,
    expires_in: data.expires_in
  });

  return data;
}

/**
 * Usa o refresh_token para obter um novo access_token
 * (para ser usado antes de chamar a API quando o token expira)
 */
async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new Error('[MELHOR_ENVIO][REFRESH] refresh_token ausente');
  }

  const cleanAuth = AUTH_URL.replace(/\/+$/, '');
  const url = `${cleanAuth}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  console.log('[ME][REFRESH] Fazendo POST para', url);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`
    },
    body
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error('[MELHOR_ENVIO][REFRESH] ERROR', resp.status, data);
    throw new Error(
      data.error_description ||
        data.message ||
        `Erro ao renovar token (status ${resp.status})`
    );
  }

  console.log('[MELHOR_ENVIO][REFRESH] OK', {
    hasAccess: !!data.access_token,
    hasRefresh: !!data.refresh_token,
    expires_in: data.expires_in
  });

  return data;
}

/**
 * Requisições autenticadas a qualquer endpoint do Melhor Envio
 * (accessToken deve ser o token válido do vendedor)
 */
async function melhorEnvioRequest(path, accessToken, options = {}) {
  if (!accessToken) {
    throw new Error('[MELHOR_ENVIO][REQUEST] accessToken não informado');
  }

  const base = BASE_URL.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  console.log('[ME][REQ] Chamando', url, 'method =', options.method || 'GET');

  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    },
    body: options.body || undefined
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error('[MELHOR_ENVIO][REQUEST] ERROR', resp.status, data);
    throw new Error(
      data.error_description ||
        data.message ||
        `Erro na API Melhor Envio (status ${resp.status})`
    );
  }

  return data;
}


/**
 * Insere um frete no carrinho do Melhor Envio (/api/v2/me/cart)
 * usando os dados do envio (remetente, destinatário, produtos, volumes, etc.).
 *
 * payloadCart deve seguir o formato da doc oficial:
 * {
 *   service: <id do serviço>,
 *   from: { ... },
 *   to: { ... },
 *   products: [ ... ],
 *   volumes: [ ... ],
 *   options: { ... }
 * }
 */
async function inserirFreteNoCarrinho(accessToken, payloadCart) {
  console.log('[ME][CART] Inserindo frete no carrinho do Melhor Envio…');
  return melhorEnvioRequest(
    '/api/v2/me/cart',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(payloadCart)
    }
  );
}

/**
 * Faz o checkout (compra) das etiquetas que estão no carrinho
 * usando os IDs retornados em /me/cart.
 *
 * shipmentIds pode ser um único ID ou um array de IDs.
 */
async function checkoutFretes(accessToken, shipmentIds) {
  const orders = Array.isArray(shipmentIds) ? shipmentIds : [shipmentIds];

  console.log('[ME][CHECKOUT] Realizando checkout de etiquetas:', orders);

  const body = { orders };

  return melhorEnvioRequest(
    '/api/v2/me/shipment/checkout',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(body)
    }
  );
}

/**
 * Gera as etiquetas para os envios comprados.
 *
 * shipmentIds pode ser um único ID ou um array de IDs.
 * Exemplo:
 *   await gerarEtiquetas(accessToken, 'ORD_123');
 *   await gerarEtiquetas(accessToken, ['ORD_123', 'ORD_456']);
 */
async function gerarEtiquetas(accessToken, shipmentIds) {
  if (!accessToken) {
    throw new Error('[MELHOR_ENVIO][LABEL] accessToken não informado');
  }

  const orders = Array.isArray(shipmentIds) ? shipmentIds : [shipmentIds];

  if (!orders.length) {
    throw new Error('[MELHOR_ENVIO][LABEL] Nenhum ID de ordem informado (orders[])');
  }

  console.log('[ME][GENERATE] Gerando etiquetas para envios:', orders);

  const body = JSON.stringify({ orders });

  const result = await melhorEnvioRequest(
    '/api/v2/me/shipment/generate',
    accessToken,
    {
      method: 'POST',
      body
    }
  );

  console.log('[MELHOR_ENVIO][LABEL] Resultado gerar etiquetas:', result);
  return result;
}

async function imprimirEtiquetas(accessToken, shipmentIds = []) {
  if (!accessToken) {
    throw new Error('[MELHOR_ENVIO][PRINT] accessToken não informado');
  }

  const orders = Array.isArray(shipmentIds) ? shipmentIds : [shipmentIds];

  if (!orders.length) {
    throw new Error('[MELHOR_ENVIO][PRINT] Nenhum shipmentId informado para impressão de etiquetas.');
  }

  const params = new URLSearchParams();
  params.set('mode', 'public');
  orders.forEach(id => params.append('orders[]', id));

  const base = BASE_URL.replace(/\/+$/, '');
  const path = `/api/v2/me/shipment/print?${params.toString()}`;
  const url = `${base}${path}`;

  console.log('[ME][PRINT] URL pública da etiqueta:', url);

  // Opcional: faz uma chamada só pra validar
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!resp.ok) {
    throw new Error(`[MELHOR_ENVIO][PRINT] Erro ao gerar etiqueta (status ${resp.status})`);
  }

  // Retorna num formato que o criarGerarEtiquetaParaPedido já entende
  return { url };
}

// Rastrear etiquetas (status + código de rastreio)
// POST /api/v2/me/shipment/tracking
async function rastrearEtiquetas(accessToken, shipmentIds = []) {
  if (!accessToken) {
    throw new Error('[MELHOR_ENVIO][TRACK] accessToken não informado');
  }

  const orders = Array.isArray(shipmentIds) ? shipmentIds : [shipmentIds];

  if (!orders.length) {
    throw new Error('[MELHOR_ENVIO][TRACK] Nenhum shipmentId informado para rastreio.');
  }

  const body = JSON.stringify({ orders });

  console.log('[ME][TRACK] Rastreando envios:', orders);

  const resp = await melhorEnvioRequest(
    '/api/v2/me/shipment/tracking',
    accessToken,
    {
      method: 'POST',
      body
    }
  );

  console.log('[ME][TRACK] Resposta rastreio:', resp);
  return resp;
}



module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  melhorEnvioRequest,
  inserirFreteNoCarrinho,
  checkoutFretes,
  gerarEtiquetas,
  imprimirEtiquetas,
  rastrearEtiquetas
};
