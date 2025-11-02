// helpers/pedidos.js
const supabaseDb = require('../supabase/supabaseDb'); // service_role

async function criarPedido({ compradorIdPF, compradorIdPJ, produtoId, lojaId, qtd }) {
  try {
    if (!produtoId) throw new Error('produtoId não informado');
    if (!compradorIdPF && !compradorIdPJ) throw new Error('Comprador não informado');

    // 1) Carrega o produto
    const { data: prod, error: prodErr } = await supabaseDb
      .from('produtos')
      .select('id, usuario_id, tipo_usuario, preco, quantidade, loja_id')
      .eq('id', produtoId)
      .maybeSingle();
    if (prodErr) throw new Error(`Falha ao buscar produto: ${prodErr.message || JSON.stringify(prodErr)}`);
    if (!prod) throw new Error(`Produto não encontrado (id=${produtoId})`);

    // 2) loja_id (pode ser null para vendedor PF)
    let _lojaId = lojaId ?? prod.loja_id ?? null;

    // 3) vendedor PF/PJ
    let vendedor_pf_id = null;
    let vendedor_pj_id = null;
    if (String(prod.tipo_usuario).toLowerCase() === 'pj') {
      vendedor_pj_id = prod.usuario_id;
    } else {
      vendedor_pf_id = prod.usuario_id;
    }

    // 4) Quantidades e preços
    const quantidade = Number(qtd) > 0 ? Number(qtd) : 1;
    const preco_unitario = Number(prod.preco || 0);
    const preco_total = +(preco_unitario * quantidade).toFixed(2);

    if (typeof prod.quantidade === 'number' && prod.quantidade < quantidade) {
      throw new Error('Estoque insuficiente para este produto');
    }

    // 5) Cria pedido (SEM inserir em pedido_itens)
    const { data: pedido, error: pedErr } = await supabaseDb
      .from('pedidos')
      .insert([{
        loja_id: _lojaId,                 // pode ser null para PF
        produto_id: produtoId,
        quantidade,
        preco_total,
        status: 'criado',
        data_pedido: new Date(),
        comprador_pf_id: compradorIdPF || null,
        comprador_pj_id: compradorIdPJ || null,
        vendedor_pf_id,
        vendedor_pj_id
      }])
      .select()
      .maybeSingle();

    if (pedErr) throw new Error(`Falha ao criar pedido: ${pedErr.message || JSON.stringify(pedErr)}`);
    if (!pedido) throw new Error('Falha ao criar pedido (sem retorno)');

    // 6) Retorna o pedido (estoque será decrementado na rota)
    return pedido;

  } catch (e) {
    const msg = e?.message || e?.error_description || e?.details || e?.code || JSON.stringify(e);
    throw new Error(`criarPedido: ${msg}`);
  }
}

module.exports = { criarPedido };
