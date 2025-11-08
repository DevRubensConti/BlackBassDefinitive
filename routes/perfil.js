const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { requireLogin } = require('../middlewares/auth'); // ✅ CORRETO

// ====== NOVO: Upload (multer) + helpers ======
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// opcional: sanitize simples de nome de arquivo
const sanitizeName = (s) => (s || '').normalize('NFKD')
  .replace(/[^\w.\-]+/g, '_')
  .slice(0, 80);

const AVATARS_BUCKET = process.env.SUPABASE_BUCKET_AVATARS || 'imagens';
// =============================================

// Filtros de produtos (mantido)
function aplicarFiltrosBasicosProdutos(query, filtros) {
  const { marca = '', tipo = '', preco_min = '', preco_max = '', q = '' } = filtros;

  if (marca && String(marca).trim()) query = query.ilike('marca', `%${marca.trim()}%`);
  if (tipo && String(tipo).trim())   query = query.ilike('tipo', `%${tipo.trim()}%`);

  const min = parseFloat(preco_min);
  if (!Number.isNaN(min)) query = query.gte('preco', min);
  const max = parseFloat(preco_max);
  if (!Number.isNaN(max)) query = query.lte('preco', max);

  // Busca textual (q) em várias colunas
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

// ====== POST com upload da foto (icone) para Supabase Storage ======
router.post('/painel/editar-usuario', requireLogin, upload.single('icone'), async (req, res) => {
  try {
    const { nome, telefone, icone_url: iconeAtualNoForm } = req.body;
    const usuarioId = req.session.usuario.id;

    let novaIconeUrl = iconeAtualNoForm || req.session.usuario.icone_url || null;

    // Se veio arquivo novo, enviar para Storage
    if (req.file && req.file.buffer && req.file.mimetype?.startsWith('image/')) {
      const original = sanitizeName(req.file.originalname);
      const filename = `${Date.now()}_${original || 'avatar.jpg'}`;
      const path = `avatars/${usuarioId}/${filename}`;

      const { error: upErr } = await supabaseDb
        .storage
        .from(AVATARS_BUCKET)
        .upload(path, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true
        });

      if (upErr) {
        console.error('[Avatar Upload] erro:', upErr);
        return res.status(500).send('Falha ao enviar imagem. Tente novamente.');
      }

      const { data: pub } = supabaseDb
        .storage
        .from(AVATARS_BUCKET)
        .getPublicUrl(path);

      novaIconeUrl = pub?.publicUrl || novaIconeUrl;
    }

    const { error } = await supabaseDb
      .from('usuarios_pf')
      .update({ nome, telefone, icone_url: novaIconeUrl })
      .eq('id', usuarioId);

    if (error) {
      console.error('Erro ao atualizar usuário:', error);
      return res.status(500).send('Erro ao atualizar perfil.');
    }

    // Atualiza sessão local
    req.session.usuario.nome = nome;
    req.session.usuario.telefone = telefone;
    req.session.usuario.icone_url = novaIconeUrl;

    res.redirect('/painel/usuario');
  } catch (e) {
    console.error('Erro geral no editar-usuario:', e);
    res.status(500).send('Erro inesperado ao atualizar perfil.');
  }
});
/* ================================================================ */

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
      marca, tipo, preco_min, preco_max, q
    });
  } catch (err) {
    console.error('Erro inesperado /usuario/:id:', err);
    return res.status(500).send('Erro no servidor.');
  }
});

module.exports = router;
