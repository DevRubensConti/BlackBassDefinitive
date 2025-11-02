const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { requireLogin } = require('../middlewares/auth');

/**
 * -------------------------------------------
 *  ROTAS DE CARRINHO (VIEW baseada em sessão)
 * -------------------------------------------
 */

// GET: Exibir carrinho (sessão)
router.get('/carrinho', requireLogin, async (req, res) => {
  const carrinho = req.session.carrinho || [];

  if (carrinho.length === 0) {
    return res.render('carrinho', { itens: [], total: 0 });
  }

  const ids = carrinho.map(i => i.id);

  const { data: produtos, error } = await supabaseDb
    .from('produtos')
    .select('*')
    .in('id', ids);

  if (error) {
    console.error('Erro ao buscar produtos do carrinho:', error);
    return res.status(500).send('Erro ao buscar produtos');
  }

  const itens = produtos.map(produto => {
    const itemCarrinho = carrinho.find(i => String(i.id) === String(produto.id));
    return {
      ...produto,
      quantidade: itemCarrinho ? itemCarrinho.quantidade : 1
    };
  });

  const total = itens.reduce((acc, item) => acc + (Number(item.preco) * Number(item.quantidade)), 0);

  res.render('carrinho', { itens, total });
});

// POST: Adicionar ao carrinho (sessão)
router.post('/carrinho/adicionar/:id', requireLogin, (req, res) => {
  const produtoId = req.params.id;

  if (!req.session.carrinho) {
    req.session.carrinho = [];
  }

  const itemExistente = req.session.carrinho.find(item => String(item.id) === String(produtoId));

  if (itemExistente) {
    itemExistente.quantidade += 1;
  } else {
    req.session.carrinho.push({ id: String(produtoId), quantidade: 1 });
  }

  res.redirect('/carrinho');
});

// POST: Remover do carrinho (sessão)
router.post('/carrinho/remover/:id', requireLogin, (req, res) => {
  const produtoId = req.params.id;

  if (!req.session.carrinho) {
    req.session.carrinho = [];
  }

  req.session.carrinho = req.session.carrinho.filter(i => String(i.id) !== String(produtoId));
  res.redirect('/carrinho');
});


/**
 * -------------------------------------------
 *  ROTAS DE CARRINHO (API com Supabase)
 *  Usadas pelo mini-cart no header
 * -------------------------------------------
 */

// GET: Lista itens do carrinho do usuário logado
router.get('/api/carrinho', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const tipoUsuario = req.session.usuario.tipo; // 'pf' ou 'pj'

  const { data: itens, error } = await supabaseDb
    .from('carrinho')
    .select(`
      *,
      produtos (
        nome,
        preco,
        imagem_url
      )
    `)
    .eq('usuario_id', usuarioId)
    .eq('tipo_usuario', tipoUsuario);

  if (error) {
    console.error(error);
    return res.status(500).json([]);
  }

  res.json(itens || []);
});

// POST: Adiciona (ou incrementa) item no carrinho do usuário logado
router.post('/api/carrinho/adicionar/:id', requireLogin, async (req, res) => {
  const produtoId = req.params.id;
  const usuarioId = req.session.usuario.id;
  const tipoUsuario = req.session.usuario.tipo; // 'pf' ou 'pj'

  // Verifica se já existe no carrinho
  const { data: existente, error: erroExistente } = await supabaseDb
    .from('carrinho')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('tipo_usuario', tipoUsuario)
    .eq('produto_id', produtoId)
    .maybeSingle();

  if (erroExistente) {
    console.error(erroExistente);
    return res.status(500).send('Erro ao verificar item no carrinho');
  }

  if (existente) {
    const { error } = await supabaseDb
      .from('carrinho')
      .update({ quantidade: Number(existente.quantidade || 0) + 1 })
      .eq('id', existente.id);

    if (error) {
      console.error(error);
      return res.status(500).send('Erro ao atualizar quantidade');
    }
  } else {
    const { error } = await supabaseDb
      .from('carrinho')
      .insert([{
        usuario_id: usuarioId,
        tipo_usuario: tipoUsuario,
        produto_id: produtoId,
        quantidade: 1
      }]);

    if (error) {
      console.error(error);
      return res.status(500).send('Erro ao adicionar ao carrinho');
    }
  }

  res.status(200).send('Item adicionado ao carrinho');
});

// POST: Incrementa ou decrementa quantidade (com remoção quando chegar a 0)
router.post('/api/carrinho/:id/:action', requireLogin, async (req, res) => {
  const itemId = req.params.id;
  const action = String(req.params.action || '').toLowerCase();

  const usuarioId = req.session.usuario.id;
  const tipoUsuario = req.session.usuario.tipo;

  if (!['plus', 'minus'].includes(action)) {
    return res.status(400).send('Ação inválida. Use "plus" ou "minus".');
  }

  // Garante que o item pertence ao usuário logado
  const { data: item, error: errorItem } = await supabaseDb
    .from('carrinho')
    .select('*')
    .eq('id', itemId)
    .eq('usuario_id', usuarioId)
    .eq('tipo_usuario', tipoUsuario)
    .maybeSingle();

  if (errorItem || !item) {
    if (errorItem) console.error(errorItem);
    return res.status(404).send('Item não encontrado');
  }

  const qtdAtual = Number(item.quantidade || 0);

  if (action === 'plus') {
    const { error } = await supabaseDb
      .from('carrinho')
      .update({ quantidade: qtdAtual + 1 })
      .eq('id', itemId);

    if (error) {
      console.error(error);
      return res.status(500).send('Erro ao incrementar quantidade');
    }
    return res.status(200).json({ ok: true, quantidade: qtdAtual + 1 });
  }

  // action === 'minus'
  if (qtdAtual <= 1) {
    // Se iria para 0, remove o item
    const { error } = await supabaseDb
      .from('carrinho')
      .delete()
      .eq('id', itemId)
      .eq('usuario_id', usuarioId)
      .eq('tipo_usuario', tipoUsuario);

    if (error) {
      console.error(error);
      return res.status(500).send('Erro ao remover item');
    }
    return res.status(200).json({ ok: true, removed: true });
  } else {
    const { error } = await supabaseDb
      .from('carrinho')
      .update({ quantidade: qtdAtual - 1 })
      .eq('id', itemId);

    if (error) {
      console.error(error);
      return res.status(500).send('Erro ao decrementar quantidade');
    }
    return res.status(200).json({ ok: true, quantidade: qtdAtual - 1 });
  }
});

// DELETE: Remove item do carrinho explicitamente
router.delete('/api/carrinho/:id', requireLogin, async (req, res) => {
  const itemId = req.params.id;
  const usuarioId = req.session.usuario.id;
  const tipoUsuario = req.session.usuario.tipo;

  const { error } = await supabaseDb
    .from('carrinho')
    .delete()
    .eq('id', itemId)
    .eq('usuario_id', usuarioId)
    .eq('tipo_usuario', tipoUsuario);

  if (error) {
    console.error(error);
    return res.status(500).send('Erro ao remover item');
  }

  res.status(200).json({ ok: true, removed: true });
});

module.exports = router;
