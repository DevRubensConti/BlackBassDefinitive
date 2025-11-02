// routes/avaliacoes.js
require('dotenv').config();
const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
// Ajuste o caminho/convenção conforme seu projeto:
// - se exporta default: const requireLogin = require('../middlewares/auth');
// - se exporta nomeado: const { requireLogin } = require('../middlewares/auth');
const { requireLogin } = require('../middlewares/auth');

const DEFAULT_LOJA_ICON_URL = process.env.DEFAULT_LOJA_ICON_URL || '/images/store-default.png';

// Helper: normaliza nota p/ 1..5
function clampNota(n) {
  const num = Math.round(Number(n));
  if (!Number.isFinite(num)) return null;
  return Math.min(5, Math.max(1, num));
}

// =====================================================
// GET reutilizável da página de avaliação (por pedido)
// Aceita /avaliar/produto/:pedidoId e /avaliar/:pedidoId
// =====================================================
// routes/avaliacoes.js  — substituir APENAS a função abaixo

async function avaliarGetHandler(req, res) {
  const rawParam = (req.params.pedidoId || '').trim(); // pode vir com espaços
  const usuarioId = req.session?.usuario?.id;

  try {
    // 1) Tenta carregar o ITEM do pedido pelo ID da tabela pedido_itens
    let item = null;
    {
      const { data, error } = await supabaseDb
        .from('pedido_itens')
        .select('id, pedido_id, produto_id, quantidade, unit_price_cents, subtotal_cents')
        .eq('id', rawParam)
        .maybeSingle();                       // evita exception quando não encontra

      if (error) {
        console.warn('avaliar: erro buscando pedido_itens por id =', rawParam, error);
      }
      item = data || null;
    }

    // 1.1) Fallback: talvez passaram um pedidos.id por engano
    if (!item) {
      console.warn('avaliar: item não encontrado por pedido_itens.id; tentando fallback como pedidos.id:', rawParam);

      // busca o cabeçalho do pedido
      const { data: pedHeader } = await supabaseDb
        .from('pedidos')
        .select('id, codigo, status, comprador_pf_id, comprador_pj_id')
        .eq('id', rawParam)
        .maybeSingle();

      if (pedHeader) {
        // pega o primeiro item ligado a esse cabeçalho
        const { data: firstItem } = await supabaseDb
          .from('pedido_itens')
          .select('id, pedido_id, produto_id, quantidade, unit_price_cents, subtotal_cents')
          .eq('pedido_id', pedHeader.id)
          .order('id', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (firstItem) {
          item = firstItem;
        }
      }
    }

    if (!item) {
      return res.status(404).send('Item do pedido não encontrado.');
    }

    // 2) Cabeçalho do pedido (valida dono e status)
    const { data: pedido, error: errPed } = await supabaseDb
      .from('pedidos')
      .select('id, codigo, status, comprador_pf_id, comprador_pj_id')
      .eq('id', item.pedido_id)
      .single();

    if (errPed || !pedido) return res.status(404).send('Pedido não encontrado.');
    if (!(pedido.comprador_pf_id === usuarioId || pedido.comprador_pj_id === usuarioId)) {
      return res.status(403).send('Sem permissão para avaliar este pedido.');
    }

    // (Opcional) só libera se entregue/finalizado
    const st = String(pedido.status || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
    const entregueLike = st.includes('entregue') || st.includes('concluido') || st.includes('finalizado');
    if (!entregueLike) {
      return res.status(403).send('Este pedido ainda não está elegível para avaliação.');
    }

    // 3) Produto do item
    const { data: produto, error: errProd } = await supabaseDb
      .from('produtos')
      .select('id, nome, descricao, imagem_url, preco, marca, condicao, tipo_usuario, usuario_id, nota_media, total_avaliacoes')
      .eq('id', item.produto_id)
      .single();
    if (errProd || !produto) return res.status(404).send('Produto do item não encontrado.');

    // 4) Vendedor (PF/PJ) + minha avaliação de vendedor
    const DEFAULT_LOJA_ICON_URL = process.env.DEFAULT_LOJA_ICON_URL || '/images/store-default.png';
    let loja = null, mediaLoja = 0, totalLoja = 0, minhaLoja = null;

    if (produto?.tipo_usuario === 'pf') {
      const { data: pf } = await supabaseDb
        .from('usuarios_pf')
        .select('id, nome, sobrenome, icone_url, cidade, estado, nota_media, total_avaliacoes')
        .eq('id', produto.usuario_id)
        .maybeSingle();
      if (pf) {
        loja = {
          id: pf.id, tipo: 'pf',
          nomeFantasia: [pf.nome, pf.sobrenome].filter(Boolean).join(' ') || 'Vendedor PF',
          icone_url: pf.icone_url || DEFAULT_LOJA_ICON_URL,
          cidade: pf.cidade || '', estado: pf.estado || ''
        };
        mediaLoja = pf.nota_media || 0;
        totalLoja = pf.total_avaliacoes || 0;
        const { data } = await supabaseDb
          .from('avaliacoes_lojas')
          .select('id, nota, comentario')
          .eq('usuario_id', usuarioId)
          .eq('vendedor_pf_id', pf.id)
          .maybeSingle();
        minhaLoja = data || null;
      }
    } else if (produto?.tipo_usuario === 'pj') {
      const { data: pj } = await supabaseDb
        .from('usuarios_pj')
        .select('id, nomeFantasia, icone_url, cidade, estado, nota_media, total_avaliacoes')
        .eq('id', produto.usuario_id)
        .maybeSingle();
      if (pj) {
        loja = {
          id: pj.id, tipo: 'pj',
          nomeFantasia: pj.nomeFantasia || 'Loja',
          icone_url: pj.icone_url || DEFAULT_LOJA_ICON_URL,
          cidade: pj.cidade || '', estado: pj.estado || ''
        };
        mediaLoja = pj.nota_media || 0;
        totalLoja = pj.total_avaliacoes || 0;
        const { data } = await supabaseDb
          .from('avaliacoes_lojas')
          .select('id, nota, comentario')
          .eq('usuario_id', usuarioId)
          .eq('vendedor_pj_id', pj.id)
          .maybeSingle();
        minhaLoja = data || null;
      }
    }

    // 5) Minha avaliação do PRODUTO
    const { data: minhaProd } = await supabaseDb
      .from('avaliacoes_produtos')
      .select('id, nota, comentario')
      .eq('usuario_id', usuarioId)
      .eq('produto_id', produto.id)
      .maybeSingle();

    // 6) Renderiza sua view existente
    return res.render('avaliar-produto', {
      pedido,        // header do pedido
      produto,       // produto do item
      loja,          // vendedor
      medias: {
        produto: { media: produto?.nota_media ?? 0, total: produto?.total_avaliacoes ?? 0 },
        loja:    { media: mediaLoja,                total: totalLoja }
      },
      minhasAvaliacoes: {
        produto: minhaProd || null,
        loja:    minhaLoja || null
      },
      pedidoItemId: item.id   // útil pra montar "back" na view
    });
  } catch (e) {
    console.error('avaliarGetHandler erro:', e);
    return res.status(500).send('Erro ao abrir a página de avaliação.');
  }
}
 

router.get(['/avaliar/produto/:pedidoId', '/avaliar/:pedidoId'], requireLogin, avaliarGetHandler);


// helper p/ garantir que sempre voltamos para /avaliar/<uuid-do-item>
// - aceita somente caminhos /avaliar/<uuid> (sem querystring)
// - se vier "back" inválido, tenta usar Referer (sem query)
// - se nada der certo, volta para /meus-pedidos
function resolveBackToAvaliacao(req, back) {
  const validar = (urlLike) => {
    if (!urlLike) return null;
    try {
      // Remove query/fragment se vierem
      const u = new URL(urlLike, 'http://localhost'); // base dummy
      const path = u.pathname; // ex.: /avaliar/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      // Aceita apenas /avaliar/<uuid-ish>
      const ok = /^\/avaliar\/[a-f0-9-]{16,}$/i.test(path);
      return ok ? path : null;
    } catch {
      // talvez já seja apenas o path (sem host)
      const path = String(urlLike).split('?')[0];
      const ok = /^\/avaliar\/[a-f0-9-]{16,}$/i.test(path);
      return ok ? path : null;
    }
  };

  // 1) tenta o "back" do form
  let dest = validar(back);
  if (dest) return dest;

  // 2) tenta o Referer do header
  const referer = req.get('Referer') || '';
  dest = validar(referer);
  if (dest) return dest;

  // 3) fallback final
  return '/meus-pedidos';
}

// =====================================================
// POST: salvar avaliação de PRODUTO
// =====================================================
router.post('/avaliacoes/produto', requireLogin, async (req, res) => {
  try {
    const usuarioId = req.session?.usuario?.id;
    const { produtoId, nota, comentario, back } = req.body;
    const n = clampNota(nota);
    if (!usuarioId || !produtoId || !n) {
      return res.status(400).send('Parâmetros inválidos.');
    }

    const payload = {
      usuario_id: usuarioId,
      produto_id: produtoId,
      nota: n,
      comentario: comentario || null
    };

    const { error } = await supabaseDb
      .from('avaliacoes_produtos')
      .upsert(payload, { onConflict: 'usuario_id,produto_id' });

    if (error) {
      console.error('Erro produto:', error);
      return res.status(500).send('Erro ao salvar avaliação do produto.');
    }

    const dest = resolveBackToAvaliacao(req, back);
    return res.redirect(dest);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Erro interno.');
  }
});

// =====================================================
// POST: salvar avaliação de VENDEDOR (PF ou PJ)
// =====================================================
router.post('/avaliacoes/loja', requireLogin, async (req, res) => {
  try {
    const usuarioId = req.session?.usuario?.id;
    const { vendedor_tipo, idRef, nota, comentario, back } = req.body; // 'pf' | 'pj'
    const n = clampNota(nota);
    const tipo = String(vendedor_tipo || '').toLowerCase();

    if (!usuarioId || !idRef || !['pf', 'pj'].includes(tipo) || !n) {
      return res.status(400).send('Parâmetros inválidos.');
    }

    const base = {
      usuario_id: usuarioId,
      nota: n,
      comentario: comentario || null,
      vendedor_pf_id: null,
      vendedor_pj_id: null
    };
    const onConflict = (tipo === 'pf') ? 'usuario_id,vendedor_pf_id' : 'usuario_id,vendedor_pj_id';
    if (tipo === 'pf') base.vendedor_pf_id = idRef; else base.vendedor_pj_id = idRef;

    const { error } = await supabaseDb
      .from('avaliacoes_lojas')
      .upsert(base, { onConflict });

    if (error) {
      console.error('Erro vendedor:', error);
      return res.status(500).send('Erro ao salvar avaliação do vendedor.');
    }

    const dest = resolveBackToAvaliacao(req, back);
    return res.redirect(dest);
  } catch (e) {
    console.error(e);
    return res.status(500).send('Erro interno.');
  }
});


module.exports = router;
