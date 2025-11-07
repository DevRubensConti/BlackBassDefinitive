// controllers/mercadopagoController.js (SDK v2, seguro PF/PJ + carrinho Supabase)
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const supabaseDb = require('../supabase/supabaseDb');

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN, // TEST-xxx ou APP_USR-xxx
  options: { timeout: 5000 }
});

const onlyDigits = (s) => (s || '').toString().replace(/\D+/g, '');
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';

/* ========== Itens do carrinho (do banco) ========== */
// Retorna [{ title, quantity, unit_price, currency_id: 'BRL' }]
async function carregarItensCarrinho(usuarioId, tipoUsuario) {
  const { data: itens, error } = await supabaseDb
    .from('carrinho')
    .select(`
      id, produto_id, quantidade,
      produtos (
        id, nome, preco, imagem_url, quantidade
      )
    `)
    .eq('usuario_id', usuarioId)
    .eq('tipo_usuario', tipoUsuario);

  if (error) throw new Error(`Erro ao carregar carrinho: ${error.message}`);
  if (!itens || !itens.length) return [];

  const mpItems = [];
  for (const row of itens) {
    const prod = row.produtos;
    if (!prod) continue;

    const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);

    // validação simples de estoque (se a coluna existir)
    if (prod.quantidade != null && Number(prod.quantidade) < qtd) {
      throw new Error(`Estoque insuficiente para o produto ${prod.id}`);
    }

    mpItems.push({
      title: prod.nome || `Produto ${prod.id}`,
      quantity: qtd,
      unit_price: Number(prod.preco) || 0,
      currency_id: 'BRL'
    });
  }

  return mpItems;
}

/* ========== CPF/CNPJ do comprador (PF/PJ) ========== */
async function carregarIdentificacaoComprador(usuarioId, tipoUsuario) {
  // PF -> tabela "usuario_pf" (coluna: cpf)
  // PJ -> tabela "usuarios_pj" (coluna: cnpj/cpnj)
  const table = (tipoUsuario === 'pj') ? 'usuarios_pj' : 'usuario_pf';

  // Tentamos por diferentes colunas de chave (ajuste conforme seu schema)
  const candidateIdCols = ['id', 'usuario_id', (tipoUsuario === 'pj' ? 'id_pj' : 'id_pf')];

  let row = null;
  for (const col of candidateIdCols) {
    const { data, error } = await supabaseDb
      .from(table)
      .select('*')
      .eq(col, usuarioId)
      .maybeSingle(); // não falha se não achar

    if (!error && data) {
      row = data;
      break;
    }
  }

  if (!row) {
    return { type: (tipoUsuario === 'pj') ? 'CNPJ' : 'CPF', number: '' };
  }

  if (tipoUsuario === 'pj') {
    const cnpj = onlyDigits(row.cpnj || row.cnpj || '');
    return { type: 'CNPJ', number: cnpj };
  } else {
    const cpf = onlyDigits(row.cpf || '');
    return { type: 'CPF', number: cpf };
  }
}

/* ========== Cria preferência ========== */
async function createPreference(req, res) {
  try {
    const usuario = req.session?.usuario || null;
    if (!usuario || !usuario.id || !usuario.tipo) {
      return res.status(401).json({ error: 'Sessão inválida. Faça login.' });
    }

    const usuarioId = usuario.id;
    const tipoUsuario = (usuario.tipo || '').toLowerCase(); // 'pf' | 'pj'

    // 1) Itens do carrinho (seguro: do banco)
    const items = await carregarItensCarrinho(usuarioId, tipoUsuario);
    if (!items.length) {
      return res.status(400).json({ error: 'Carrinho vazio.' });
    }

    // 2) Payer a partir da sessão + CPF/CNPJ buscado
    const identification = await carregarIdentificacaoComprador(usuarioId, tipoUsuario);

    // Fallback de sandbox: se vazio e não for produção, preenche doc de teste
    if (!identification.number && !isProd) {
      identification.number = (identification.type === 'CPF')
        ? '12345678909'     // CPF teste (APRO)
        : '11222333000181'; // CNPJ teste
    }

    const payer = {
      name: usuario.nome || usuario.apelido || 'Cliente',
      email: usuario.email || 'cliente@example.com',
      identification // { type: 'CPF'|'CNPJ', number: 'somente_digitos' }
    };

    // 3) URLs absolutas (sem auto_return por enquanto)
    const BASE = (process.env.MP_BASE_URL || 'http://localhost:3000/api/checkout').trim();
    const successUrl = (process.env.MP_SUCCESS_URL || `${BASE}/sucesso`).trim();
    const pendingUrl = (process.env.MP_PENDING_URL || `${BASE}/pendente`).trim();
    const failureUrl = (process.env.MP_FAILURE_URL || `${BASE}/erro`).trim();
    const notificationUrl = (process.env.MP_WEBHOOK_URL || 'http://localhost:3000/api/checkout/webhook').trim();

    if (!/^https?:\/\//i.test(successUrl)) {
      return res.status(500).json({ error: 'URL de sucesso inválida (use http/https absolutos).' });
    }

    const preferenceBody = {
      items,
      payer,
      back_urls: {
        success: successUrl,
        pending: pendingUrl,
        failure: failureUrl
      },
      notification_url: notificationUrl,
      external_reference: 'ORDER-' + Date.now()
      // sem auto_return por enquanto (evita erro 400)
    };

    console.log('[MP createPreference] body:', preferenceBody);

    // 4) Cria preferência (SDK v2)
    const pref = new Preference(mpClient);
    const resp = await pref.create({ body: preferenceBody });

    const initPoint = resp.init_point || resp.sandbox_init_point;
    if (!initPoint) {
      return res.status(500).json({ error: 'Preferência criada sem init_point.' });
    }

    // 5) Retorna link para o front redirecionar
    return res.json({ init_point: initPoint });

  } catch (err) {
    const status = err?.status || 500;
    const message = err?.message || 'Erro ao criar preferência';
    console.error('Erro ao criar preferência (MP v2):', err);
    return res.status(status).json({ error: message });
  }
}

async function handleWebhook(req, res) {
  try {
    const raw = req.body?.toString('utf8') || '{}';
    const event = JSON.parse(raw); // { type: 'payment', data: { id: '...' } }

    if (event?.type === 'payment' && event?.data?.id) {
      const payment = await new Payment(mpClient).get({ id: event.data.id });

      console.log('MP Webhook:', {
        id: payment.id,
        status: payment.status,                 // approved | pending | rejected ...
        external_reference: payment.external_reference
      });

      // TODO: atualizar pedido no Supabase, ex.:
      // await supabaseDb
      //   .from('pedidos')
      //   .update({ status_pagamento: payment.status, mp_payment_id: payment.id })
      //   .eq('codigo', payment.external_reference); // ou .eq('id', ...) conforme seu schema
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook (MP v2):', err);
    return res.sendStatus(200);
  }
}

// Exporte tudo no final (evita problemas de ordem)
module.exports = {
  createPreference,
  handleWebhook,
  mpClient
};
