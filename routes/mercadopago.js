// routes/mercadopago.js
// Integração Checkout Pro (SDK v2) + webhook cria pedidos no Supabase

const express = require('express');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const supabaseDb = require('../supabase/supabaseDb');

const router = express.Router();

// ===========================
//  SDK Mercado Pago
// ===========================
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN
});

function getEnvFromToken(token) {
  return (token || '').startsWith('TEST-') ? 'SANDBOX' : 'PRODUCAO';
}

// ===========================
//  Utils (webhook/raw + pedidos)
// ===========================
function safeParseRawBody(req) {
  try {
    if (!req?.body) return null;
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function carregarCarrinhoSnapshot(compradorId, tipoUsuario) {
  const { data, error } = await supabaseDb
    .from('carrinho')
    .select(`
      id, produto_id, quantidade,
      produtos (
        id, preco, usuario_id, tipo_usuario, loja_id, nome, imagem_url, quantidade
      )
    `)
    .eq('usuario_id', compradorId)
    .eq('tipo_usuario', tipoUsuario);

  if (error) throw new Error('Erro carregando carrinho: ' + JSON.stringify(error));
  return data || [];
}

function agruparPorLoja(itensCarrinho) {
  const porLoja = new Map();
  for (const row of itensCarrinho) {
    const prod = row.produtos;
    if (!prod || !prod.loja_id) continue;

    const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);
    if (prod.quantidade != null && Number(prod.quantidade) < qtd) {
      throw new Error(`Estoque insuficiente p/ produto ${row.produto_id}`);
    }
    if (!porLoja.has(prod.loja_id)) porLoja.set(prod.loja_id, []);
    porLoja.get(prod.loja_id).push({
      produto_id: row.produto_id,
      quantidade: qtd,
      preco: Number(prod.preco) || undefined,
      nome: prod.nome || undefined,
      imagem_url: (prod.imagem_url || '').split(',')[0] || undefined
    });
  }
  return porLoja;
}

function gerarCodigoPedido(lojaId) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 9000) + 1000;
  const lojaPrefix = String(lojaId || '').replace(/-/g, '').slice(0, 4).toUpperCase();
  return `L${lojaPrefix}-${y}${m}${day}-${rand}`;
}

// ===========================
//  Criar preferência (Checkout Pro)
// ===========================
router.post('/create-preference', async (req, res) => {
  try {
    const { items, buyer, debug } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio.' });
    }

    // Sessão do comprador
    const compradorId = req.session?.usuario?.id;
    const tipoUsuario = (req.session?.usuario?.tipo || '').toLowerCase(); // 'pf' | 'pj'
    if (!compradorId || !tipoUsuario) {
      return res.status(401).json({ error: 'Sessão expirada: faça login novamente.' });
    }

    // Normaliza itens
    const normItems = items.map(it => ({
      title: String(it.title || 'Item'),
      quantity: Number(it.quantity || 1),
      unit_price: Number(it.unit_price || 0),
      currency_id: it.currency_id || 'BRL'
    })).filter(x => x.quantity > 0 && x.unit_price >= 0);

    const env = getEnvFromToken(process.env.MP_ACCESS_TOKEN);

    // MP coleta CPF no checkout — enviamos só nome/email
    const payer = {
      name: (buyer && buyer.name) || 'Cliente',
      email: (buyer && buyer.email) || 'cliente@example.com'
    };

    // Cliente Preference
    const preference = new Preference(mpClient);

    // Referência única p/ rastrear esta intenção (idempotência/relatos)
    const externalRef = `chk_${compradorId}_${Date.now()}`;

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

      external_reference: externalRef,
      metadata: {
        buyerEmail: payer.email,
        mp_env: env,
        comprador_id: compradorId,   // usado pelo webhook
        tipo_usuario: tipoUsuario,   // 'pf' | 'pj'
        debug_ts: new Date().toISOString()
      }
    };

    // Log de entrada
    console.log('[MP][CREATE_PREF] IN', {
      env,
      tokenPrefix: String(process.env.MP_ACCESS_TOKEN || '').slice(0, 10) + '…',
      compradorId,
      tipoUsuario,
      items: normItems,
      payer,
      ip: req.ip,
      ua: req.get('user-agent')
    });

    const result = await preference.create({ body });

    // Log de saída
    const usedUrl = result.init_point || result.sandbox_init_point;
    console.log('[MP][CREATE_PREF] OUT', {
      id: result.id,
      usedUrl, // qual link será usado
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      date_created: result.date_created,
      live_mode: result.live_mode // true=produção, false=sandbox (pode vir undefined)
    });

    const initPoint = usedUrl;
    if (!initPoint) {
      console.error('[MP][CREATE_PREF] Sem init_point:', result);
      return res.status(500).json({ error: 'Sem init_point retornado pelo MP.' });
    }

    if (debug) {
      return res.json({ init_point: initPoint, result, request_body: body });
    }

    return res.json({ init_point: initPoint });

  } catch (error) {
    console.error('[MP][CREATE_PREF] ERROR', error);
    return res.status(500).json({
      error: 'Erro ao criar preferência',
      details: String(error?.message || error)
    });
  }
});

// ===========================
//  Webhook (processa pagamento aprovado -> cria pedidos)
// ===========================
router.post('/webhook', async (req, res) => {
  try {
    // Vem assinatura/ids nos headers; body é raw (express.raw configurado no app.js)
    const signature = req.get('x-signature');
    const requestId = req.get('x-request-id');

    // Descobrir paymentId
    let paymentId = null;

    // Ex.: /webhook?type=payment&data.id=123
    if (req.query?.type === 'payment' && req.query['data.id']) {
      paymentId = req.query['data.id'];
    }

    // Corpo raw (pode variar por configuração da conta)
    if (!paymentId) {
      const json = safeParseRawBody(req);
      paymentId = json?.data?.id || json?.resource?.id || json?.id || null;
    }

    console.log('📨 Webhook MP recebido:', {
      signature,
      requestId,
      qs: req.query,
      paymentId,
      hasRaw: !!req.body,
      len: req.body?.length
    });

    if (!paymentId) {
      // Retornamos 200 para evitar novas tentativas, mas sem processar
      return res.status(200).send('No payment id');
    }

    // Busca pagamento
    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: paymentId });

    console.log('[MP][WEBHOOK] Payment fetched', {
      id: payment.id,
      status: payment.status,
      status_detail: payment.status_detail,
      live_mode: payment.live_mode,
      external_reference: payment.external_reference,
      metadata: payment.metadata
    });

    // Processa apenas aprovados
    if (payment.status !== 'approved') {
      return res.status(200).send('Ignored: not approved');
    }

    // Quem é o comprador?
    const compradorId = payment.metadata?.comprador_id;
    const tipoUsuario = payment.metadata?.tipo_usuario; // 'pf' | 'pj'
    if (!compradorId || !tipoUsuario) {
      console.error('[MP][WEBHOOK] metadata sem comprador/tipo:', payment.metadata);
      return res.status(400).send('Metadata incompleta');
    }

    // (Opcional) Idempotência:
    // crie uma tabela payments_processados(payment_id TEXT PK) e cheque aqui
    // se já processou este payment.id. Se sim, return 200.

    // Snapshot do carrinho na aprovação
    const itensCarrinho = await carregarCarrinhoSnapshot(compradorId, tipoUsuario);
    if (!itensCarrinho?.length) {
      console.warn('[MP][WEBHOOK] Carrinho vazio no momento da aprovação', { compradorId, tipoUsuario });
      return res.status(200).send('Carrinho vazio');
    }

    // Criar pedidos por loja
    const porLoja = agruparPorLoja(itensCarrinho);
    const isPF = (String(tipoUsuario).toLowerCase() === 'pf');

    for (const [lojaId, itens] of porLoja.entries()) {
      const codigo = gerarCodigoPedido(lojaId);

      const { data: pid, error: rpcErr } = await supabaseDb.rpc('create_pedido_with_itens', {
        _loja: lojaId,
        _status: 'pago', // status inicial após aprovação
        _tipo_usuario: tipoUsuario,
        _itens: itens,
        _comprador_pf_id: isPF ? compradorId : null,
        _comprador_pj_id: !isPF ? compradorId : null,
        _codigo: codigo
      });

      if (rpcErr) {
        console.error('[MP][WEBHOOK] Erro criando pedido RPC:', rpcErr);
        // Retorne 500 para o MP re-tentar depois
        return res.status(500).send('Erro criando pedido');
      }
    }

    // Decrementar estoque
    for (const row of itensCarrinho) {
      const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);
      const { error: decErr } = await supabaseDb.rpc('decrementa_estoque', {
        p_id: row.produto_id,
        p_qtd: qtd
      });
      if (decErr) {
        console.error('[MP][WEBHOOK] Erro decrementando estoque', row.produto_id, decErr);
      }
    }

    // Limpar carrinho
    const { error: delErr } = await supabaseDb
      .from('carrinho')
      .delete()
      .eq('usuario_id', compradorId)
      .eq('tipo_usuario', tipoUsuario);

    if (delErr) {
      console.warn('[MP][WEBHOOK] Carrinho não limpo (continuando):', delErr);
    }

    // (Opcional) gravar payment.id como processado (idempotência)
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no webhook do Mercado Pago:', err);
    return res.status(500).send('Erro no webhook');
  }
});

// ===========================
//  Páginas de retorno (UX)
// ===========================
router.get('/sucesso', (req, res) => res.render('sucesso', { query: req.query }));
router.get('/pendente', (req, res) => res.render('pendente', { query: req.query }));
router.get('/erro', (req, res) => res.render('erro', { query: req.query }));

// ===========================
//  Debug (ambiente/token)
// ===========================
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
