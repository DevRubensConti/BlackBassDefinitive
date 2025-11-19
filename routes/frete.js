// routes/frete.js (ou checkout.js)
const express = require('express');
const supabaseDb = require('../supabase/supabaseDb');
const { carregarCarrinhoSnapshot } = require('../utils/carrinho');
const { melhorEnvioRequest } = require('../services/melhorEnvio'); // serviço de integração

const router = express.Router();

// GET /checkout/frete – mostra a página do gateway de frete
router.get('/checkout/frete', async (req, res) => {
  try {
    const usr = req.session?.usuario || {};
    const compradorId = usr?.id;
    const tipoUsuario = (usr?.tipo || '').toLowerCase();

    if (!compradorId || !tipoUsuario) {
      return res.redirect('/login');
    }

    // reaproveita a mesma lógica do carrinho
    const itensCarrinho = await carregarCarrinhoSnapshot(compradorId, tipoUsuario);

    const subtotal = itensCarrinho.reduce((acc, row) => {
      const prod = row.produtos || {};
      const preco = Number(prod.preco || 0);
      const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);
      return acc + preco * qtd;
    }, 0);

    // frete que o usuário eventualmente já escolheu antes
    const freteSelecionado = req.session.freteSelecionado || null;

    // ===============================
    // Integração com Melhor Envio
    // ===============================
    let cotacoes = [];

    try {
      // 1) pega token do Melhor Envio salvo no banco
      const { data: tokenRow, error: tokenErr } = await supabaseDb
        .from('melhorenvio_tokens')
        .select('*')
        .eq('usuario_id', compradorId) // depois você pode trocar para o id da loja
        .maybeSingle();

      if (tokenErr) {
        console.warn('[FRETE][GET] Erro lendo token Melhor Envio:', tokenErr);
      }

      if (tokenRow?.access_token) {
        const accessToken = tokenRow.access_token;

        // 2) monta payload de cotação (exemplo; depois refine com peso/medidas reais)
        const payload = {
          from: {
            // CEP de origem da loja (por enquanto fixo/mocado)
            postal_code: '13097173'
          },
          to: {
            // CEP do comprador – se ainda não tiver em usr, coloca um fallback
            postal_code: usr.cep || '13097173'
          },
          products: itensCarrinho.map((row) => {
            const prod = row.produtos || {};
            const qtd = Number(row.quantidade || 1);
            return {
              id: prod.id,
              width: 11,
              height: 2,
              length: 16,
              weight: 0.3,
              quantity: qtd,
              insurance_value: Number(prod.preco || 0) * qtd
            };
          })
        };

        // 3) chama a API de cálculo do Melhor Envio
        cotacoes = await melhorEnvioRequest(
          '/api/v2/me/shipment/calculate',
          accessToken,
          {
            method: 'POST',
            body: JSON.stringify(payload)
          }
        );

        console.log('[FRETE][GET] Cotações Melhor Envio:', cotacoes?.length || 0);
      } else {
        console.warn('[FRETE][GET] Nenhum access_token do Melhor Envio encontrado, usando opções mock.');
      }
    } catch (errME) {
      console.error('[FRETE][GET] Erro na cotação Melhor Envio:', errME);
      // se der erro, só segue com cotacoes = [] e as opções mock do EJS
    }

    return res.render('frete_gateway', {
      usuario: usr,
      itensCarrinho,
      subtotal,
      freteSelecionado,
      cotacoes // agora a view tem acesso às cotações reais (quando existirem)
    });
  } catch (err) {
    console.error('[FRETE][GET] ERRO', err);
    return res.status(500).send('Erro ao carregar página de frete.');
  }
});

// POST /checkout/frete – recebe opção de frete e segue para pagamento (Bricks)
router.post('/checkout/frete', (req, res) => {
  try {
    const { metodo, valor, prazo } = req.body;

    // guarda na sessão pra usar depois no /api/checkout/bricks
    req.session.freteSelecionado = {
      metodo: metodo || 'desconhecido',
      valor: Number(valor || 0),
      prazo: prazo || ''
    };

    // segue para a página de pagamento com Bricks
    return res.redirect('/api/checkout/bricks');
  } catch (err) {
    console.error('[FRETE][POST] ERRO', err);
    return res.status(500).send('Erro ao salvar frete.');
  }
});

module.exports = router;
