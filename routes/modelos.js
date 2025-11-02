// routes/api.js (ou no seu produtos.js)
const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { normalizeSimple } = require('../utils/normalizeText'); 

// GET /api/modelos?marca=Fender&shape=Stratocaster
router.get('/api/modelos', async (req, res) => {
  const marcaN = normalizeSimple(req.query.marca);
  const shapeN = normalizeSimple(req.query.shape);

  if (!marcaN || !shapeN) return res.json({ modelos: [] });

  // se quiser tolerar dados antigos, use ilike; se não, pode manter eq
  let { data, error } = await supabaseDb
    .from('catalogo_modelos')
    .select('modelo')
    .eq('ativo', true)
    .ilike('marca', marcaN)
    .ilike('shape', shapeN);

  if (error) return res.status(500).json({ error: 'Erro ao consultar catálogo.' });

  let modelos = (data || []).map(r => r.modelo).filter(Boolean);

  if (modelos.length === 0) {
    const fb = await supabaseDb.from('produtos')
      .select('modelo')
      .ilike('marca', marcaN)
      .ilike('shape', shapeN);
    if (!fb.error && fb.data) modelos = fb.data.map(r => r.modelo).filter(Boolean);
  }

  const unicos = [...new Set(modelos.map(normalizeSimple))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));

  res.json({ modelos: unicos });
});

module.exports = router;
