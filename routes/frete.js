// routes/checkout.js (exemplo)
const express = require('express');
const { carregarCarrinhoSnapshot } = require('../utils/carrinho');

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

    return res.render('frete_gateway', {
      usuario: usr,
      itensCarrinho,
      subtotal,
      freteSelecionado
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
