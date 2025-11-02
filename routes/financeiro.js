// routes/financeiro.js
const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { requireLogin } = require('../middlewares/auth');

/* ============================
   1) Middleware: requireLoja (via lojas.usuario_id)
   ============================ */
async function requireLoja(req, res, next) {
  try {
    const sess = req.session?.usuario;
    if (!sess) return res.status(401).send('Não autenticado.');

    const userId = sess.id;

    // Se vier lojaId, valida que pertence ao usuário
    const lojaParam = req.query.lojaId || req.params.lojaId || null;
    if (lojaParam) {
      const { data: loja, error } = await supabaseDb
        .from('lojas')
        .select('id, usuario_id, nomeFantasia:nome_fantasia, nome_fantasia, cidade, estado, icone_url, taxa_comissao_pct')
        .eq('id', lojaParam)
        .eq('usuario_id', userId)
        .single();
      if (error) return res.status(500).json({ error });
      if (!loja)  return res.status(403).send('Essa loja não pertence ao usuário logado.');
      req.session.loja_id = loja.id; // cache opcional
      req.loja = loja;
      return next();
    }

    // Sem lojaId: pega a loja do usuário (se tiver mais de uma, pega a mais recente)
    const { data: lojas, error } = await supabaseDb
      .from('lojas')
      .select('id, usuario_id, nomeFantasia:nome_fantasia, nome_fantasia, cidade, estado, icone_url, taxa_comissao_pct, criado_em')
      .eq('usuario_id', userId)
      .order('criado_em', { ascending: false })
      .limit(1);

    if (error) return res.status(500).json({ error });
    if (!lojas || !lojas.length) return res.status(404).send('Nenhuma loja encontrada para este usuário.');

    req.session.loja_id = lojas[0].id;
    req.loja = lojas[0];
    return next();
  } catch (e) {
    console.error('requireLoja erro:', e);
    return res.status(500).send('Falha ao identificar a loja do usuário.');
  }
}

/* ============================
   2) Helpers de período e agregação
   ============================ */
function getPeriodo(req) {
  const { de, ate } = req.query || {};
  return {
    de: de || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    ate: ate || new Date().toISOString().slice(0, 10),
  };
}

async function carregarLinhas(lojaId, de, ate) {
  const { data, error } = await supabaseDb
    .from('v_pedidos_financeiro')
    .select('dia, realizacao, produto_id, quantidade, preco_total, receita_marketplace, repasse_loja')
    .eq('loja_id', lojaId)
    .gte('dia', de)
    .lte('dia', ate);
  if (error) throw error;
  return data || [];
}

function agregarResumo(linhas) {
  const acc = {};
  for (const r of linhas) {
    if (r.realizacao === 'fora') continue;
    const k = r.realizacao;
    if (!acc[k]) acc[k] = { pedidos: 0, gmv: 0, receita_marketplace: 0, repasse_loja: 0 };
    acc[k].pedidos++;
    acc[k].gmv += Number(r.preco_total || 0);
    acc[k].receita_marketplace += Number(r.receita_marketplace || 0);
    acc[k].repasse_loja += Number(r.repasse_loja || 0);
  }
  const ticket = (a) => (a && a.pedidos ? +(a.gmv / a.pedidos).toFixed(2) : 0);
  return {
    realizado: {
      pedidos: acc.realizado?.pedidos || 0,
      gmv: +(acc.realizado?.gmv || 0).toFixed(2),
      receita_marketplace: +(acc.realizado?.receita_marketplace || 0).toFixed(2),
      repasse_loja: +(acc.realizado?.repasse_loja || 0).toFixed(2),
      ticket_medio: ticket(acc.realizado),
    },
    previsto: {
      pedidos: acc.previsto?.pedidos || 0,
      gmv: +(acc.previsto?.gmv || 0).toFixed(2),
      receita_marketplace: +(acc.previsto?.receita_marketplace || 0).toFixed(2),
      repasse_loja: +(acc.previsto?.repasse_loja || 0).toFixed(2),
      ticket_medio: ticket(acc.previsto),
    },
  };
}

function agregarDiario(linhas) {
  const by = {};
  for (const r of linhas) {
    if (r.realizacao === 'fora') continue;
    const key = `${r.dia}|${r.realizacao}`;
    if (!by[key]) by[key] = { dia: r.dia, realizacao: r.realizacao, pedidos: 0, gmv: 0, receita_marketplace: 0, repasse_loja: 0 };
    by[key].pedidos++;
    by[key].gmv += Number(r.preco_total || 0);
    by[key].receita_marketplace += Number(r.receita_marketplace || 0);
    by[key].repasse_loja += Number(r.repasse_loja || 0);
  }
  return Object.values(by).sort((a, b) => a.dia.localeCompare(b.dia));
}

async function topProdutos(linhas, limit = 10) {
  const map = {};
  for (const r of linhas) {
    if (r.realizacao !== 'realizado') continue;
    const k = r.produto_id;
    if (!map[k]) map[k] = { produto_id: k, pedidos: 0, qtd_total: 0, gmv: 0 };
    map[k].pedidos++;
    map[k].qtd_total += Number(r.quantidade || 0);
    map[k].gmv += Number(r.preco_total || 0);
  }
  const top = Object.values(map).sort((a, b) => b.gmv - a.gmv).slice(0, limit);

  if (top.length) {
    const ids = top.map(t => t.produto_id);
    const { data: prods } = await supabaseDb
      .from('produtos')
      .select('id, nome, imagem_url')
      .in('id', ids);
    const meta = Object.fromEntries((prods || []).map(p => [p.id, p]));
    top.forEach(t => {
      t.nome = meta[t.produto_id]?.nome || t.produto_id;
      t.imagem_url = meta[t.produto_id]?.imagem_url?.split(',')[0] || null;
    });
  }
  return top;
}

/* ============================
   3) APIs
   ============================ */

// Resumo realizado/previsto
router.get('/api/minha-loja/financeiro/resumo', requireLogin, requireLoja, async (req, res) => {
  try {
    const { de, ate } = getPeriodo(req);
    const lojaId = req.loja.id;
    const linhas = await carregarLinhas(lojaId, de, ate);
    const resumo = agregarResumo(linhas);
    res.json({
      loja: { id: lojaId, nome: req.loja.nomeFantasia || req.loja.nome_fantasia },
      periodo: { de, ate },
      ...resumo,
    });
  } catch (error) {
    return res.status(500).json({ error });
  }
});

// Série diária agregada
router.get('/api/minha-loja/financeiro/diario', requireLogin, requireLoja, async (req, res) => {
  try {
    const { de, ate } = getPeriodo(req);
    const lojaId = req.loja.id;
    const linhas = await carregarLinhas(lojaId, de, ate);
    res.json(agregarDiario(linhas));
  } catch (error) {
    return res.status(500).json({ error });
  }
});

// Top produtos (com nome/imagem)
router.get('/api/minha-loja/financeiro/top-produtos', requireLogin, requireLoja, async (req, res) => {
  try {
    const { de, ate } = getPeriodo(req);
    const lojaId = req.loja.id;
    const limit = Number(req.query.limit || 10);
    const linhas = await carregarLinhas(lojaId, de, ate);
    res.json(await topProdutos(linhas, limit));
  } catch (error) {
    return res.status(500).json({ error });
  }
});

// Export CSV
router.get('/api/minha-loja/financeiro/export.csv', requireLogin, requireLoja, async (req, res) => {
  try {
    const { de, ate } = getPeriodo(req);
    const lojaId = req.loja.id;

    const { data, error } = await supabaseDb
      .from('v_pedidos_financeiro')
      .select('dia,id,status,preco_total,comissao_pct,receita_marketplace,repasse_loja')
      .eq('loja_id', lojaId)
      .gte('dia', de).lte('dia', ate)
      .order('dia', { ascending: true });

    if (error) return res.status(500).json({ error });

    const header = 'dia,pedido_id,status,valor,comissao_pct,receita_marketplace,repasse_loja';
    const rows = (data || []).map(r =>
      [r.dia, r.id, r.status, r.preco_total, r.comissao_pct, r.receita_marketplace, r.repasse_loja].join(',')
    );
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="financeiro_${lojaId}_${de}_${ate}.csv"`);
    res.send(csv);
  } catch (error) {
    return res.status(500).json({ error });
  }
});

/* ============================
   4) Página do vendedor (SSR)
   ============================ */
router.get('/minha-loja/financeiro', requireLogin, requireLoja, async (req, res) => {
  try {
    const { de, ate } = getPeriodo(req);
    const lojaId = req.loja.id;
    const linhas = await carregarLinhas(lojaId, de, ate);

    const resumo = agregarResumo(linhas);
    const diario = agregarDiario(linhas);
    const topProdutosArr = await topProdutos(linhas, 10);

    res.render('loja-financeiro', {
      loja: req.loja,
      de,
      ate,
      resumo,
      diario,
      topProdutos: topProdutosArr
    });
  } catch (error) {
    console.error('render financeiro erro:', error);
    res.status(500).send('Falha ao carregar o financeiro da loja.');
  }
});

module.exports = router;
