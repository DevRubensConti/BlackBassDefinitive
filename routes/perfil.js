const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { requireLogin } = require('../middlewares/auth'); // ✅ CORRETO

function aplicarFiltrosBasicosProdutos(query, filtros) {
  const { marca = '', tipo = '', preco_min = '', preco_max = '', q = '' } = filtros;

  if (marca && String(marca).trim()) query = query.ilike('marca', `%${marca.trim()}%`);
  if (tipo && String(tipo).trim())   query = query.ilike('tipo', `%${tipo.trim()}%`);

  const min = parseFloat(preco_min);
  if (!Number.isNaN(min)) query = query.gte('preco', min);
  const max = parseFloat(preco_max);
  if (!Number.isNaN(max)) query = query.lte('preco', max);

  // --- Busca textual (q) em múltiplas colunas, com suporte a várias palavras ---
  if (q && String(q).trim()) {
    const termos = String(q).trim().split(/\s+/).filter(Boolean);
    termos.forEach((t) => {
      const pattern = `*${t}*`;
      query = query.or(
        `ilike(nome,${pattern}),ilike(marca,${pattern}),ilike(tipo,${pattern}),ilike(tags,${pattern})`
      );
    });
  }

  return query;
}

// GET: Página de perfil de Pessoa Física
router.get('/perfil', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario?.id;
  const tipo = req.session.usuario?.tipo;

  if (!usuarioId || tipo !== 'pf') {
    return res.redirect('/login');
  }

  const { data: usuario, error } = await supabaseDb
    .from('usuarios_pf')
    .select('*')
    .eq('id', usuarioId)
    .single();

  if (error || !usuario) {
    console.error('Erro ao buscar dados do perfil:', error);
    return res.status(500).send('Erro ao carregar perfil.');
  }

  res.render('perfil', { usuario });
});

router.get('/painel/usuario', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;

  const { data: produtos, error } = await supabaseDb
    .from('produtos')
    .select('*')
    .eq('usuario_id', usuarioId);

  if (error) {
    console.error('Erro ao buscar produtos:', error);
    return res.status(500).send('Erro ao carregar seus produtos.');
  }

  res.render('painel-usuario', { usuario: req.session.usuario, produtos });
});

router.get('/painel/editar-usuario', requireLogin, async (req, res) => {
  const usuario = req.session.usuario;
  res.render('editar-usuario', { usuario });
});

router.post('/painel/editar-usuario', requireLogin, async (req, res) => {
  const { nome, telefone, icone_url } = req.body;
  const usuarioId = req.session.usuario.id;

  const { error } = await supabaseDb
    .from('usuarios_pf')
    .update({ nome, telefone, icone_url })
    .eq('id', usuarioId);

  if (error) {
    console.error('Erro ao atualizar usuário:', error);
    return res.status(500).send('Erro ao atualizar perfil.');
  }

  // Atualiza a sessão local para refletir mudanças
  req.session.usuario.nome = nome;
  req.session.usuario.telefone = telefone;
  req.session.usuario.icone_url = icone_url;

  res.redirect('/painel/usuario');
});

/* =============== Página pública do usuário (PF) =============== */
router.get('/usuario/:id', async (req, res) => {
  try {
    const usuarioId = req.params.id;

    const { marca = '', tipo = '', preco_min = '', preco_max = '', q = '' } = req.query;

    const { data: usuario, error: usuarioError } = await supabaseDb
      .from('usuarios_pf')
      .select(`
        id, nome, email, telefone, icone_url,
        descricao, cidade, estado,
        nota_media, total_avaliacoes
      `)
      .eq('id', usuarioId)
      .maybeSingle();

    if (usuarioError || !usuario) {
      console.error('Erro PF:', usuarioError);
      return res.status(404).send('Usuário não encontrado.');
    }

    let query = supabaseDb
      .from('produtos')
      .select(`id, nome, preco, imagem_url, tags, marca, tipo, created_at`)
      .eq('usuario_id', usuarioId)
      .eq('tipo_usuario', 'pf')
      .order('created_at', { ascending: false });

    // 🔎 aplica filtros + q
    query = aplicarFiltrosBasicosProdutos(query, { marca, tipo, preco_min, preco_max, q });

    const { data: produtos, error: produtosError } = await query;

    if (produtosError) {
      console.error('Erro produtos PF:', produtosError);
      return res.status(500).send('Erro ao buscar produtos do usuário.');
    }

    return res.render('usuario-publico', {
      usuario,
      produtos: produtos || [],
      marca, tipo, preco_min, preco_max, q // <-- devolve q para o template
    });
  } catch (err) {
    console.error('Erro inesperado /usuario/:id:', err);
    return res.status(500).send('Erro no servidor.');
  }
});



module.exports = router;
