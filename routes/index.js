const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');

// Página inicial - lista de produtos recentes
router.get('/', async (req, res) => {
  try {
    // 🧩 Produtos mais vistos
    const { data: maisVistos, error: mvError } = await supabaseDb
      .from('produtos')
      .select('id, nome, preco, imagem_url, shape, marca, condicao, acessos')
      .order('acessos', { ascending: false })
      .limit(8);

    // 🏆 Lojas com melhores avaliações (Top 10) — usando nota_media
    const { data: lojasTopRaw, error: lojasError } = await supabaseDb
      .from('usuarios_pj')
      .select('id, nomeFantasia, icone_url, nota_media')
      .order('nota_media', { ascending: false })
      .limit(10);

    if (mvError || lojasError) {
      console.error('Erro ao buscar dados:', mvError || lojasError);
      return res.status(500).send('Erro ao buscar dados.');
    }

    // 🔧 Normaliza para número
    const lojasTop = (lojasTopRaw || []).map(loja => ({
      ...loja,
      nota_media: parseFloat(loja.nota_media) || 0,
    }));

    // Renderiza a página inicial
    res.render('index', { 
      maisVistos, 
      lojasTop
    });

  } catch (e) {
    console.error('Erro na home:', e);
    res.status(500).send('Erro no servidor.');
  }
});




// Página de plano de assinatura
router.get('/plano-assinatura', (req, res) => {
  res.render('plano-assinatura');
});

// Página de teste de sessão (opcional para debug)
router.get('/teste', (req, res) => {
  console.log('req.session:', req.session);
  console.log('req.session.usuario:', req.session.usuario);
  res.send({
    session: req.session,
    usuario: req.session.usuario
  });
});




module.exports = router;
