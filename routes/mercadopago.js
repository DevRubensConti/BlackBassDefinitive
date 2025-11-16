// routes/mercadopago.js
// Integração Mercado Pago Bricks + webhook cria pedidos no Supabase

const express = require('express');
const { MercadoPagoConfig, Payment } = require('mercadopago');
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

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || '';
}

function onlyDigits(s) {
  return (s || '').toString().replace(/\D+/g, '');
}

function splitPhone(brPhone) {
  const d = onlyDigits(brPhone);
  // tenta DDD + número (8-9 dígitos)
  if (d.length >= 10) {
    return { area_code: d.slice(0, 2), number: d.slice(2) };
  }
  return { area_code: '', number: d };
}

// ===========================
//  Webhook (processa pagamento aprovado -> cria pedidos)
// ===========================
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.get('x-signature');
    const requestId = req.get('x-request-id');

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

    // 👉 ignora pagamentos que já foram processados via Bricks
    if (payment.metadata?.via === 'BRICKS') {
      console.log('[MP][WEBHOOK] Pagamento via BRICKS já processado. Ignorando no webhook.');
      return res.status(200).send('Handled by BRICKS');
    }

    // Processa apenas aprovados
    if (payment.status !== 'approved') {
      return res.status(200).send('Ignored: not approved');
    }

    const compradorId = payment.metadata?.comprador_id;
    const tipoUsuario = payment.metadata?.tipo_usuario; // 'pf' | 'pj'
    if (!compradorId || !tipoUsuario) {
      console.error('[MP][WEBHOOK] metadata sem comprador/tipo:', payment.metadata);
      return res.status(400).send('Metadata incompleta');
    }

    const itensCarrinho = await carregarCarrinhoSnapshot(compradorId, tipoUsuario);
    if (!itensCarrinho?.length) {
      console.warn('[MP][WEBHOOK] Carrinho vazio no momento da aprovação', {
        compradorId,
        tipoUsuario
      });
      return res.status(200).send('Carrinho vazio');
    }

    const porLoja = agruparPorLoja(itensCarrinho);
    const isPF = String(tipoUsuario).toLowerCase() === 'pf';

    for (const [lojaId, itens] of porLoja.entries()) {
      const codigo = gerarCodigoPedido(lojaId);

      const { data: pid, error: rpcErr } = await supabaseDb.rpc(
        'create_pedido_with_itens',
        {
          _loja: lojaId,
          _status: 'pago',
          _tipo_usuario: tipoUsuario,
          _itens: itens,
          _comprador_pf_id: isPF ? compradorId : null,
          _comprador_pj_id: !isPF ? compradorId : null,
          _codigo: codigo
        }
      );

      if (rpcErr) {
        console.error('[MP][WEBHOOK] Erro criando pedido RPC:', rpcErr);
        return res.status(500).send('Erro criando pedido');
      }
    }

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

    const { error: delErr } = await supabaseDb
      .from('carrinho')
      .delete()
      .eq('usuario_id', compradorId)
      .eq('tipo_usuario', tipoUsuario);

    if (delErr) {
      console.warn('[MP][WEBHOOK] Carrinho não limpo (continuando):', delErr);
    }

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

// ===========================
//  Página de checkout com Brick
// ===========================
router.get('/bricks', async (req, res) => {
  try {
    const usr = req.session?.usuario || {};
    const compradorId = usr?.id;
    const tipoUsuario = (usr?.tipo || '').toLowerCase(); // 'pf' | 'pj'

    if (!compradorId || !tipoUsuario) {
      return res.redirect('/login');
    }

    const itensCarrinho = await carregarCarrinhoSnapshot(compradorId, tipoUsuario);

    const subtotal = itensCarrinho.reduce((acc, row) => {
      const prod = row.produtos || {};
      const preco = Number(prod.preco || 0);
      const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);
      return acc + preco * qtd;
    }, 0);

    const frete = req.session.freteSelecionado || { valor: 0 };

    const total = subtotal + Number(frete.valor || 0);

    return res.render('checkout_bricks', {
      mpPublicKey: process.env.MP_PUBLIC_KEY,
      totalAmount: total || 0,
      usuario: usr,
      itensCarrinho,
      subtotal,
      frete
    });
  } catch (err) {
    console.error('[BRICKS][GET] ERRO', err);
    return res.status(500).send('Erro carregando checkout bricks');
  }
});
// ===========================
//  Bricks – processa pagamento
// ===========================
router.post('/bricks/process-payment', async (req, res) => {
  try {
    // LOG inicial: sempre mostra que a rota foi chamada
    console.log('[BRICKS][PAYMENT] HIT ROUTE', {
      bodyType: typeof req.body,
      isBuffer: Buffer.isBuffer(req.body)
    });

    const usr = req.session?.usuario || {};
    const compradorId = usr?.id;
    const tipoUsuario = (usr?.tipo || '').toLowerCase(); // 'pf' | 'pj'

    if (!compradorId || !tipoUsuario) {
      return res.status(401).json({ error: 'Sessão expirada: faça login novamente.' });
    }

    // 🔴 Aqui é o pulo do gato: garantir que o body seja um OBJETO
    let payload = req.body;

    if (Buffer.isBuffer(payload)) {
      try {
        payload = JSON.parse(payload.toString('utf8'));
      } catch (e) {
        console.error('[BRICKS][PAYMENT] Body não é JSON válido:', e);
        return res.status(400).json({
          error: 'Corpo da requisição inválido (não é JSON).',
          details: String(e?.message || e)
        });
      }
    }

    const {
  token,
  paymentMethodId,
  payment_method_id,
  issuerId,
  issuer_id,
  installments,
  amount,
  transaction_amount,
  payer: payerFromBrick
} = payload || {};

// aceita tanto camelCase quanto snake_case
const pmId = paymentMethodId || payment_method_id;
const issId = issuerId || issuer_id;
const transactionAmount = Number(amount || transaction_amount || 0);

if (!token || !pmId || !transactionAmount) {
  console.error('[BRICKS][PAYMENT] Dados insuficientes', {
    hasToken: !!token,
    paymentMethodId: paymentMethodId,
    payment_method_id,
    transactionAmount
  });
  return res.status(400).json({
    error: 'Dados insuficientes para criar pagamento.',
    details: {
      token: !!token,
      paymentMethodId: paymentMethodId,
      payment_method_id,
      amount: transactionAmount
    }
  });
}

    // ========= Buscar dados reais do comprador no Supabase =========
    let perfil = null;
    if (tipoUsuario === 'pf') {
      const { data, error } = await supabaseDb
        .from('usuarios_pf')
        .select(
          'nome, email, cpf, telefone, cep, endereco, numero, cidade, estado, bairro, complemento'
        )
        .eq('id', compradorId)
        .maybeSingle();
      if (error) throw new Error('Erro carregando usuarios_pf: ' + JSON.stringify(error));
      perfil = data || {};
    } else {
      const { data, error } = await supabaseDb
        .from('usuarios_pj')
        .select(
          'nomeFantasia, email, cnpj, telefone, cep, endereco, numero, cidade, estado, bairro, complemento'
        )
        .eq('id', compradorId)
        .maybeSingle();
      if (error) throw new Error('Erro carregando usuarios_pj: ' + JSON.stringify(error));
      perfil = data || {};
    }

    const nome =
      payerFromBrick?.name ||
      perfil?.nome ||
      perfil?.nomeFantasia ||
      usr?.nome ||
      usr?.apelido ||
      'Cliente';

    const email =
      payerFromBrick?.email || perfil?.email || usr?.email || 'cliente@example.com';

    const docTypeFromBrick = payerFromBrick?.identification?.type;
    const docNumberFromBrick = payerFromBrick?.identification?.number;

    let identification = undefined;
    if (docNumberFromBrick) {
      identification = {
        type: docTypeFromBrick || (tipoUsuario === 'pf' ? 'CPF' : 'CNPJ'),
        number: onlyDigits(docNumberFromBrick)
      };
    } else if (tipoUsuario === 'pf' && perfil?.cpf) {
      identification = {
        type: 'CPF',
        number: onlyDigits(perfil.cpf)
      };
    } else if (tipoUsuario === 'pj' && perfil?.cnpj) {
      identification = {
        type: 'CNPJ',
        number: onlyDigits(perfil.cnpj)
      };
    }

    const payer = {
      email,
      first_name: nome,
      identification
    };

    const env = getEnvFromToken(process.env.MP_ACCESS_TOKEN);

    console.log('[BRICKS][PAYMENT] IN', {
      env,
      compradorId,
      tipoUsuario,
      transactionAmount,
      paymentMethodId,
      installments,
      issuerId,
      payer
    });

    const paymentClient = new Payment(mpClient);

const paymentBody = {
  transaction_amount: transactionAmount,
  token,
  description: 'Compra BlackBass',
  installments: Number(installments || 1),
  payment_method_id: pmId,
  issuer_id: issId || undefined,
  payer,
  metadata: {
    comprador_id: compradorId,
    tipo_usuario: tipoUsuario,
    mp_env: env,
    via: 'BRICKS'
  }
};

    const payment = await paymentClient.create({ body: paymentBody });

    console.log('[BRICKS][PAYMENT] OUT', {
      id: payment.id,
      status: payment.status,
      status_detail: payment.status_detail,
      live_mode: payment.live_mode
    });

    if (payment.status !== 'approved') {
      return res.status(200).json({
        status: payment.status,
        status_detail: payment.status_detail,
        id: payment.id
      });
    }

    // ========= Aprovado: cria pedidos + decrementa estoque + limpa carrinho =========
    const itensCarrinho = await carregarCarrinhoSnapshot(compradorId, tipoUsuario);
    if (!itensCarrinho?.length) {
      console.warn('[BRICKS][PAYMENT] Carrinho vazio na aprovação', {
        compradorId,
        tipoUsuario
      });
      return res.status(200).json({
        status: payment.status,
        status_detail: payment.status_detail,
        id: payment.id,
        warning: 'Carrinho vazio no momento da aprovação.'
      });
    }

    const porLoja = agruparPorLoja(itensCarrinho);
    const isPF = String(tipoUsuario).toLowerCase() === 'pf';

    for (const [lojaId, itens] of porLoja.entries()) {
      const codigo = gerarCodigoPedido(lojaId);

      const { data: pid, error: rpcErr } = await supabaseDb.rpc(
        'create_pedido_with_itens',
        {
          _loja: lojaId,
          _status: 'pago',
          _tipo_usuario: tipoUsuario,
          _itens: itens,
          _comprador_pf_id: isPF ? compradorId : null,
          _comprador_pj_id: !isPF ? compradorId : null,
          _codigo: codigo
        }
      );

      if (rpcErr) {
        console.error('[BRICKS][PAYMENT] Erro criando pedido RPC:', rpcErr);
        return res.status(500).json({ error: 'Erro criando pedido', details: rpcErr });
      }
    }

    for (const row of itensCarrinho) {
      const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);
      const { error: decErr } = await supabaseDb.rpc('decrementa_estoque', {
        p_id: row.produto_id,
        p_qtd: qtd
      });
      if (decErr) {
        console.error('[BRICKS][PAYMENT] Erro decrementando estoque', row.produto_id, decErr);
      }
    }

    const { error: delErr } = await supabaseDb
      .from('carrinho')
      .delete()
      .eq('usuario_id', compradorId)
      .eq('tipo_usuario', tipoUsuario);

    if (delErr) {
      console.warn('[BRICKS][PAYMENT] Carrinho não limpo (continuando):', delErr);
    }

    return res.status(200).json({
      status: payment.status,
      status_detail: payment.status_detail,
      id: payment.id,
      pedidos_criados: true
    });
  } catch (err) {
    console.error('[BRICKS][PAYMENT] ERROR', err);
    return res.status(500).json({
      error: 'Erro ao processar pagamento com Bricks',
      details: String(err?.message || err)
    });
  }
});

module.exports = router;
