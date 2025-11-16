const supabaseDb = require('../supabase/supabaseDb');

async function carregarCarrinhoSnapshot(compradorId, tipoUsuario) {
  const { data, error } = await supabaseDb
    .from('carrinho')
    .select(`
      id, produto_id, quantidade,
      produtos (
        id, preco, usuario_id, tipo_usuario, loja_id, nome, imagem_url, quantidade
      )
    `)
    .eq('usuario_id', compradorId)
    .eq('tipo_usuario', tipoUsuario);

  if (error) throw new Error('Erro carregando carrinho: ' + JSON.stringify(error));
  return data || [];
}

module.exports = { carregarCarrinhoSnapshot };
