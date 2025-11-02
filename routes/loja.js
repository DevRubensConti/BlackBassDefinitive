// routes/loja.js
const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { requireLogin } = require('../middlewares/auth'); // removido requirePJ
const multer = require('multer');
const path = require('path');

/* =============== Helpers Financeiro =============== */
function getPeriodo(req) {
  const { de, ate } = req.query || {};
  return {
    de: de || new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    ate: ate || new Date().toISOString().slice(0, 10),
  };
}

async function carregarLinhasFinanceiro(lojaId, de, ate) {
  
  if (!lojaId) return [];
  const { data, error } = await supabaseDb
    .from('v_pedidos_financeiro')
    .select('dia, realizacao, pedido_id, produto_id, quantidade, preco_total, receita_marketplace, repasse_loja') // + pedido_id
    .eq('loja_id', lojaId)
    .gte('dia', de)
    .lte('dia', ate);
  if (error) {
    console.error('Erro linhas financeiro:', error);
    return [];
  }
  return data || [];
}

function agregarResumo(linhas) {
  // sets para contar pedidos únicos por realização
  const pedidosSet = { realizado: new Set(), previsto: new Set() };
  const acc = {
    realizado: { pedidos: 0, gmv: 0, receita_marketplace: 0, repasse_loja: 0 },
    previsto:  { pedidos: 0, gmv: 0, receita_marketplace: 0, repasse_loja: 0 },
  };

  for (const r of linhas) {
    if (r.realizacao === 'fora') continue;
    const k = r.realizacao; // 'realizado' | 'previsto'
    acc[k].gmv               += Number(r.preco_total || 0);
    acc[k].receita_marketplace += Number(r.receita_marketplace || 0);
    acc[k].repasse_loja      += Number(r.repasse_loja || 0);
    if (r.pedido_id) pedidosSet[k].add(r.pedido_id);
  }

  acc.realizado.pedidos = pedidosSet.realizado.size;
  acc.previsto.pedidos  = pedidosSet.previsto.size;

  const ticket = (a) => (a && a.pedidos ? +(a.gmv / a.pedidos).toFixed(2) : 0);

  return {
    realizado: {
      pedidos: acc.realizado.pedidos,
      gmv: +acc.realizado.gmv.toFixed(2),
      receita_marketplace: +acc.realizado.receita_marketplace.toFixed(2),
      repasse_loja: +acc.realizado.repasse_loja.toFixed(2),
      ticket_medio: ticket(acc.realizado),
    },
    previsto: {
      pedidos: acc.previsto.pedidos,
      gmv: +acc.previsto.gmv.toFixed(2),
      receita_marketplace: +acc.previsto.receita_marketplace.toFixed(2),
      repasse_loja: +acc.previsto.repasse_loja.toFixed(2),
      ticket_medio: ticket(acc.previsto),
    },
  };
}

function agregarDiario(linhas) {
  // chave: `${dia}|${realizacao}`
  const by = {};
  const pedidosSet = {}; // chave -> Set de pedido_id

  for (const r of linhas) {
    if (r.realizacao === 'fora') continue;
    const key = `${r.dia}|${r.realizacao}`;
    if (!by[key]) {
      by[key] = { dia: r.dia, realizacao: r.realizacao, pedidos: 0, gmv: 0, receita_marketplace: 0, repasse_loja: 0 };
      pedidosSet[key] = new Set();
    }
    by[key].gmv += Number(r.preco_total || 0);
    by[key].receita_marketplace += Number(r.receita_marketplace || 0);
    by[key].repasse_loja += Number(r.repasse_loja || 0);
    if (r.pedido_id) pedidosSet[key].add(r.pedido_id);
  }

  // converte Set em contagem de pedidos
  Object.keys(by).forEach(k => {
    by[k].pedidos = pedidosSet[k].size;
  });

  return Object.values(by).sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
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

// ==== KPIs "Minhas Vendas" (últimos 30d, realizados) ====
async function carregarKpis30d(lojaId, fimISO) {
  try {
    const ate = fimISO || new Date().toISOString().slice(0,10);
    const de  = new Date(new Date(ate).getTime() - 29*24*60*60*1000).toISOString().slice(0,10);

    const { data, error } = await supabaseDb
      .from('v_pedidos_financeiro')
      .select('pedido_id, quantidade, preco_total')
      .eq('loja_id', lojaId)
      .eq('realizacao','realizado')
      .gte('dia', de).lte('dia', ate);

    if (error) throw error;

    const linhas = data || [];
    const pedidosDistinct = new Set(linhas.map(r => r.pedido_id).filter(Boolean));
    const pedidos30       = pedidosDistinct.size;
    const itensVendidos   = linhas.reduce((s,r)=> s + Number(r.quantidade||0), 0);
    const gmv             = linhas.reduce((s,r)=> s + Number(r.preco_total||0), 0);
    const ticketMedio     = pedidos30 ? +(gmv/pedidos30).toFixed(2) : 0;

    return { pedidos30, itensVendidos, ticketMedio };
  } catch(e){
    console.error('KPIs 30d erro:', e);
    return { pedidos30:0, itensVendidos:0, ticketMedio:0 };
  }
}


// ==== Lista de vendas (tabela), com filtros da UI ====
async function carregarVendasTabela(lojaId, { inicio, fim, status_pedido }) {
  try {
    let q = supabaseDb
      .from('v_minhas_vendas_pj')
      .select('pedido_id, data_pedido, status, itens, total_pedido')
      .eq('loja_id', lojaId)
      .order('data_pedido', { ascending: false })
      .limit(200);

    if (inicio) q = q.gte('data_pedido', `${inicio} 00:00:00`);
    if (fim)    q = q.lte('data_pedido',   `${fim} 23:59:59`);
    if (status_pedido) q = q.eq('status', status_pedido);

    const { data, error } = await q;
    if (error) throw error;

    // Se quiser enriquecer com comprador/produto, dá pra buscar depois pelo pedido_id.
    return (data || []).map(r => ({
      id: r.pedido_id,
      codigo: r.pedido_id,            // ajuste se tiver campo 'codigo' em outra tabela
      data_pedido: r.data_pedido,
      cliente_nome: '-',              // opcional: preencher depois
      produto_nome: '-',              // opcional: preencher depois
      qtd_itens: r.itens,
      preco_total: r.total_pedido,
      status: r.status
    }));
  } catch(e){
    console.error('Vendas tabela erro:', e);
    return [];
  }
}

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

/* =============== Listagem de lojas =============== */
router.get('/lojas', async (req, res) => {
  try {
    // 1) Captura filtros da URL
    const nome = (req.query.nome || '').trim();
    const estado = (req.query.estado || '').trim().toUpperCase(); // Exemplo: 'SP'
    const notaMin = Number(req.query.nota_min || 0);

    // 2) Monta a query base
    let query = supabaseDb
      .from('usuarios_pj')
      .select('id, nomeFantasia, estado, nota_media, icone_url')
      .order('nomeFantasia', { ascending: true });

    // 3) Aplica os filtros
    if (nome) {
      // Busca parcial no nome da loja
      query = query.ilike('nomeFantasia', `%${nome}%`);
    }

    if (estado) {
      // Filtra por sigla do estado (SP, RJ, etc)
      query = query.eq('estado', estado);
    }

    if (!isNaN(notaMin) && notaMin > 0) {
      // Filtra lojas com nota >= notaMin
      query = query.gte('nota_media', notaMin);
    }

    // 4) Executa a consulta
    const { data: lojas, error } = await query;

    if (error) throw error;

    // 5) Renderiza a página com os filtros mantidos
    res.render('listings-lojas', {
      lojas: lojas || [],
      query: {
        nome,
        estado,
        nota_min: notaMin ? String(notaMin) : ''
      }
    });
  } catch (err) {
    console.error('Erro ao buscar lojas:', err);
    res.status(500).send('Erro ao carregar lojas');
  }
});

/* =============== Página pública da loja =============== */
/* =============== Página pública da loja =============== */
router.get('/loja/:id', async (req, res) => {
  try {
    const lojaId = req.params.id;
    const { marca = '', tipo = '', preco_min = '', preco_max = '', q = '' } = req.query;

    const { data: loja, error: lojaError } = await supabaseDb
      .from('usuarios_pj')
      .select(`
        id, nomeFantasia, cidade, estado, telefone, icone_url, descricao,
        nota_media, total_avaliacoes
      `)
      .eq('id', lojaId)
      .maybeSingle();

    if (lojaError || !loja) {
      console.error('Erro loja PJ:', lojaError);
      return res.status(404).send('Loja não encontrada.');
    }

    let query = supabaseDb
      .from('produtos')
      .select(`id, nome, preco, imagem_url, tags, marca, tipo, created_at`)
      .eq('usuario_id', lojaId)
      .eq('tipo_usuario', 'pj')
      .order('created_at', { ascending: false });

    // 🔎 aplica filtros + q
    query = aplicarFiltrosBasicosProdutos(query, { marca, tipo, preco_min, preco_max, q });

    const { data: produtos, error: prodError } = await query;
    if (prodError) {
      console.error('Erro produtos loja:', prodError);
      return res.status(500).send('Erro ao buscar produtos desta loja.');
    }

    return res.render('loja', {
      loja,
      produtos: produtos || [],
      marca, tipo, preco_min, preco_max, q // <-- devolve q para o template
    });
  } catch (err) {
    console.error('Erro inesperado /loja/:id:', err);
    return res.status(500).send('Erro no servidor.');
  }
});


/* =============== Compra (placeholder) =============== */
router.post('/comprar/:id', requireLogin, async (req, res) => {
  const itemId = req.params.id;
  res.send(`Compra registrada para o produto ${itemId}`);
});

/* =============== Painel da Loja (embutindo Financeiro) =============== */
router.get('/painel/loja', requireLogin, async (req, res) => {
  try {
    const usuario = req.session.usuario;

    // Restrição simples a PJ
    if ((usuario?.tipo || '').toLowerCase() !== 'pj') {
      return res.status(403).send('Acesso restrito a lojas (usuário PJ).');
    }

    // (1) Perfil da loja (cabeçalho)
    const { data: lojaPerfil, error: erroPerfil } = await supabaseDb
      .from('usuarios_pj')
      .select('*')
      .eq('id', usuario.id)
      .single();
    if (erroPerfil) throw erroPerfil;

    // (2) Produtos do dono
    const { data: produtos, error: prodError } = await supabaseDb
      .from('produtos')
      .select('*')
      .eq('usuario_id', usuario.id);
    if (prodError) throw prodError;

    // (3) Loja financeira (tabela `lojas`)
    const { data: lojas, error: lojaErr } = await supabaseDb
      .from('lojas')
      .select('id, usuario_id, nome_fantasia, taxa_comissao_pct, criado_em')
      .eq('usuario_id', usuario.id)
      .order('criado_em', { ascending: false })
      .limit(1);

    let finDe = null, finAte = null, finResumo = null, finDiario = [], finTop = [];
    let lojaFinanceira = null;
    if (lojaErr) {
      console.error('Erro buscando lojas financeiras:', lojaErr);
    }
    if (lojas && lojas.length) {
      lojaFinanceira = lojas[0];
      const { de, ate } = getPeriodo(req);
      finDe = de; finAte = ate;

      const linhas = await carregarLinhasFinanceiro(lojaFinanceira.id, de, ate);
      console.log('[PAINEL] lojaFinanceira.id =', lojaFinanceira?.id);
console.log('[PAINEL] período:', de, '->', ate);
console.log('[PAINEL] linhas v_pedidos_financeiro:', linhas.length);
console.log('[PAINEL] amostra:', linhas.slice(0,3));

      finResumo = agregarResumo(linhas);
      finDiario = agregarDiario(linhas);
      finTop    = await topProdutos(linhas, 10);
    } else {
      const { de, ate } = getPeriodo(req);
      finDe = de; finAte = ate;
      finResumo = agregarResumo([]);
      finDiario = [];
      finTop = [];
    }

    // (4) MINHAS VENDAS – filtros, tabela e KPIs 30d
    const filtrosVendas = {
      inicio: req.query.inicio || '',
      fim: req.query.fim || '',
      status_pedido: req.query.status_pedido || ''
    };

    const vendas = lojaFinanceira
      ? await carregarVendasTabela(lojaFinanceira.id, filtrosVendas)
      : [];

    const kpis = lojaFinanceira
      ? await carregarKpis30d(lojaFinanceira.id, finAte)
      : { pedidos30:0, itensVendidos:0, ticketMedio:0 };

    // Render
    res.render('painel-loja', {
      loja: lojaPerfil,
      produtos: produtos || [],

      // financeiros:
      finDe, finAte, finResumo, finDiario, finTop,

      // minhas vendas:
      filtrosVendas,
      kpis,
      vendas,

      // compat:
      selected: req.query,
      relatorio: {}
    });
  } catch (error) {
    console.error('Erro ao carregar painel da loja:', error);
    return res.status(500).send('Erro ao carregar painel');
  }
});


/* =============== API: Minhas Vendas – análise (rosca) =============== */
/**
 * GET /api/minha-loja/vendas/analise
 * Query params:
 *   - group: 'marca' | 'categoria' | 'shape'  (default: 'marca')
 *   - de, ate: 'YYYY-MM-DD' (default: últimos 30 dias)
 * Retorno:
 *   {
 *     group, de, ate,
 *     total_gmv, total_pedidos, total_qtd,
 *     series: [{ label, gmv, pedidos, qtd, pct }, ...] // Top 8 + "Outros"
 *   }
 */
router.get('/api/minha-loja/vendas/analise', requireLogin, async (req, res) => {
  try {
    const usuario = req.session.usuario;
    if ((usuario?.tipo || '').toLowerCase() !== 'pj') {
      return res.status(403).send('Acesso restrito a lojas (usuário PJ).');
    }

    // Loja (tabela lojas) pertencente ao usuário
    const { data: lojas, error: lojaErr } = await supabaseDb
      .from('lojas')
      .select('id')
      .eq('usuario_id', usuario.id)
      .order('criado_em', { ascending: false })
      .limit(1);
    if (lojaErr) throw lojaErr;
    if (!lojas?.length) return res.json({ group: null, series: [], total_gmv: 0, total_pedidos: 0, total_qtd: 0 });

    const lojaId = lojas[0].id;

    // Parâmetros
    let group = (req.query.group || 'marca').toLowerCase();
    if (!['marca','categoria','shape'].includes(group)) group = 'marca';
    const de = req.query.de || new Date(Date.now() - 29*24*60*60*1000).toISOString().slice(0,10);
    const ate = req.query.ate || new Date().toISOString().slice(0,10);

    // 1) Pedidos no período
    const { data: linhas, error: linErr } = await supabaseDb
      .from('v_pedidos_financeiro')
      .select('produto_id, quantidade, preco_total, realizacao, dia')
      .eq('loja_id', lojaId)
      .gte('dia', de).lte('dia', ate);
    if (linErr) throw linErr;

    // Apenas realizados (vendas efetivas)
    const efetivas = (linhas || []).filter(l => l.realizacao === 'realizado');
    if (!efetivas.length) {
      return res.json({ group, de, ate, total_gmv: 0, total_pedidos: 0, total_qtd: 0, series: [] });
    }

    // 2) Metadados dos produtos (marca/categoria/shape)
    const prodIds = [...new Set(efetivas.map(l => l.produto_id).filter(Boolean))];
    const { data: prods, error: prodErr } = await supabaseDb
      .from('produtos')
      .select('id, marca, categoria, tipo, shape')
      .in('id', prodIds);
    if (prodErr) throw prodErr;
    const meta = Object.fromEntries((prods || []).map(p => [p.id, p]));

    // 3) Agregar por dimensão
    const getLabel = (pid) => {
      const p = meta[pid] || {};
      if (group === 'marca')     return p.marca || 'Sem marca';
      if (group === 'categoria') return p.categoria || p.tipo || 'Sem categoria';
      if (group === 'shape')     return p.shape || 'Sem shape';
      return 'Outro';
    };

    const acc = {};
    let totGMV = 0, totPedidos = 0, totQtd = 0;

    for (const l of efetivas) {
      const label = getLabel(l.produto_id);
      if (!acc[label]) acc[label] = { label, gmv: 0, pedidos: 0, qtd: 0 };
      acc[label].gmv += Number(l.preco_total || 0);
      acc[label].pedidos += 1;
      acc[label].qtd += Number(l.quantidade || 0);
      totGMV += Number(l.preco_total || 0);
      totPedidos += 1;
      totQtd += Number(l.quantidade || 0);
    }

    // 4) Top N + "Outros"
    const N = 8;
    const arr = Object.values(acc).sort((a,b) => b.gmv - a.gmv);
    const top = arr.slice(0, N);
    const rest = arr.slice(N);
    if (rest.length) {
      top.push({
        label: 'Outros',
        gmv: rest.reduce((s,i)=>s+i.gmv,0),
        pedidos: rest.reduce((s,i)=>s+i.pedidos,0),
        qtd: rest.reduce((s,i)=>s+i.qtd,0),
      });
    }

    // % sobre GMV total
    top.forEach(s => { s.pct = totGMV ? +((s.gmv / totGMV) * 100).toFixed(2) : 0; });

    res.json({
      group, de, ate,
      total_gmv: +totGMV.toFixed(2),
      total_pedidos: totPedidos,
      total_qtd: totQtd,
      series: top
    });
  } catch (e) {
    console.error('analise vendas erro:', e);
    res.status(500).json({ error: 'Falha ao carregar análise.' });
  }
});



/* =============== Editar Loja (sem requirePJ) =============== */
router.get('/painel/editar-loja', requireLogin, async (req, res) => {
  const usuario = req.session.usuario;
  if ((usuario?.tipo || '').toLowerCase() !== 'pj') {
    return res.status(403).send('Acesso restrito a lojas (usuário PJ).');
  }

  const { data: loja, error } = await supabaseDb
    .from('usuarios_pj')
    .select('*')
    .eq('id', usuario.id)
    .single();

  if (error) {
    console.error('Erro ao buscar dados da loja:', error);
    return res.status(500).send('Erro ao carregar edição da loja');
  }

  res.render('editar-loja', { loja });
});

/* =============== Upload ícone loja (mantido) =============== */
const storage = multer.diskStorage({
  destination: 'public/uploads/icones/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

router.post('/painel/editar-loja', requireLogin, upload.single('icone'), async (req, res) => {
  const usuario = req.session.usuario;
  if ((usuario?.tipo || '').toLowerCase() !== 'pj') {
    return res.status(403).send('Acesso restrito a lojas (usuário PJ).');
    }

  const { nomeFantasia, telefone, estado, cidade, endereco, descricao } = req.body;
  const icone_url = req.file ? `/uploads/icones/${req.file.filename}` : undefined;

  const updates = { nomeFantasia, telefone, estado, cidade, endereco, descricao };
  if (icone_url) updates.icone_url = icone_url;

  const { error } = await supabaseDb
    .from('usuarios_pj')
    .update(updates)
    .eq('id', usuario.id);

  if (error) {
    console.error(error);
    return res.status(500).send('Erro ao atualizar loja');
  }

  if (icone_url) {
    req.session.usuario.icone_url = icone_url;
  }

  res.redirect('/painel/loja');
});

module.exports = router;
