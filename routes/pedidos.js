const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb'); // caminho correto do seu client Supabase
const { requireLogin } = require('../middlewares/auth'); // ajuste se o nome estiver diferente
const { criarPedido } = require('../helpers/pedidos')

router.get('/meus-pedidos', requireLogin, async (req, res) => {
  try {
    const compradorId = req.session.usuario.id;

    // 1) Cabeçalhos
    const { data: pedidos, error: pedErr } = await supabaseDb
      .from('pedidos')
      .select('id, codigo, status, data_pedido, preco_total')
      .or(`comprador_pf_id.eq.${compradorId},comprador_pj_id.eq.${compradorId}`)
      .order('data_pedido', { ascending: false });

    if (pedErr) {
      console.error('Erro ao buscar pedidos:', pedErr);
      return res.status(500).send('Erro ao buscar seus pedidos');
    }
    if (!pedidos?.length) {
      return res.render('meus-pedidos', { grupos: [], pedidos: [] });
    }

    const pedidoIds = pedidos.map(p => p.id);

    // 2) Itens dos pedidos (UMA LINHA POR PRODUTO)
    //    >>> Inclui o ID do item (pedido_itens.id) <<<
    const { data: itens, error: itensErr } = await supabaseDb
      .from('pedido_itens')
      .select('id, pedido_id, produto_id, nome, imagem_url, quantidade, unit_price_cents, subtotal_cents') // <-- id adicionado
      .in('pedido_id', pedidoIds);

    if (itensErr) {
      console.error('Erro ao buscar itens do pedido:', itensErr);
      return res.status(500).send('Erro ao buscar itens do pedido');
    }

    // 2.1) Fallback de imagem
    const faltamImgs = [...new Set((itens || [])
      .filter(it => !it.imagem_url)
      .map(it => it.produto_id))];

    let imgFallbackByProdId = {};
    if (faltamImgs.length) {
      const { data: prodsImg, error: imgErr } = await supabaseDb
        .from('produtos')
        .select('id, imagem_url')
        .in('id', faltamImgs);
      if (imgErr) {
        console.warn('Falha buscando imagens fallback:', imgErr);
      } else {
        imgFallbackByProdId = Object.fromEntries(
          (prodsImg || []).map(p => [p.id, (p.imagem_url || '').split(',')[0] || null])
        );
      }
    }

    // 3) Indexa itens por pedido_id — mantendo IDs necessários
    const itensByPedido = {};
    for (const it of (itens || [])) {
      if (!itensByPedido[it.pedido_id]) itensByPedido[it.pedido_id] = [];
      const img = it.imagem_url || imgFallbackByProdId[it.produto_id] || '/images/placeholder.png';

      itensByPedido[it.pedido_id].push({
        // >>> IDs essenciais para os botões/links <<<
        pedido_item_id: it.id,          // <-- este é o UUID de pedido_itens usado em /avaliar/:id
        pedido_id: it.pedido_id,        // útil como fallback
        produto_id: it.produto_id,

        // dados de exibição
        nome: it.nome || '(sem nome)',
        imagem_url: img,
        quantidade: Number(it.quantidade || 0),
        unitario: Number(it.unit_price_cents || 0) / 100,
        subtotal: Number(it.subtotal_cents || 0) / 100
      });
    }

    // 4) Agrupa por código (cada código pode ter N itens)
    const gruposMap = {};
    for (const p of pedidos) {
      const key = (p.codigo && String(p.codigo).trim()) || `ID-${p.id}`;

      if (!gruposMap[key]) {
        gruposMap[key] = {
          codigo: p.codigo || null,
          data: p.data_pedido,
          status: p.status,
          total: Number(p.preco_total || 0),
          pedidos_ids: new Set(),
          itens: []
        };
      }

      gruposMap[key].pedidos_ids.add(p.id);

      // Anexa os itens DESTE pedido preservando pedido_item_id/pedido_id/produto_id
      const itensDoPedido = itensByPedido[p.id] || [];
      gruposMap[key].itens.push(...itensDoPedido);

      // Mantém data/status do mais recente
      if (new Date(p.data_pedido) > new Date(gruposMap[key].data)) {
        gruposMap[key].data = p.data_pedido;
        gruposMap[key].status = p.status;
      }

      // (Se quiser somar total de múltiplos cabeçalhos com mesmo código, descomente)
      // gruposMap[key].total += Number(p.preco_total || 0);
    }

    // 4.1) (Opcional) define um pedido_id "preferido" no grupo (mais recente) para fallback
    for (const key of Object.keys(gruposMap)) {
      const ids = Array.from(gruposMap[key].pedidos_ids.values());
      const maisRecente = pedidos
        .filter(px => ids.includes(px.id))
        .sort((a, b) => new Date(b.data_pedido) - new Date(a.data_pedido))[0];
      gruposMap[key].pedido_id = maisRecente ? maisRecente.id : (ids[0] || null);
    }

    // 5) Ordena grupos por data desc
    const grupos = Object.values(gruposMap).sort((a, b) => new Date(b.data) - new Date(a.data));

    // Render
    res.render('meus-pedidos', { grupos, pedidos });
  } catch (err) {
    console.error('Erro geral /meus-pedidos:', err);
    return res.status(500).send('Erro ao carregar seus pedidos');
  }
});




router.get('/minhas-vendas', requireLogin, async (req, res) => {
  const vendedorId = req.session.usuario.id;

  const { data: vendas, error } = await supabaseDb
    .from('pedidos')
    .select(`
      id,
      status,
      data_pedido,
      preco_total,
      quantidade,
      produto:produtos (
        id,
        nome,
        imagem_url
      ),
      comprador_pf:usuarios_pf (
        id,
        nome
      ),
      comprador_pj:usuarios_pj (
        id,
        nomeFantasia
      )
    `)
    // vendedor pode estar em uma das duas colunas
    .or(`vendedor_pf_id.eq.${vendedorId},vendedor_pj_id.eq.${vendedorId}`)
    .order('data_pedido', { ascending: false });

  if (error) {
    console.error('Erro ao buscar vendas:', error);
    return res.status(500).send('Erro ao buscar suas vendas');
  }

  res.render('minhas-vendas', { vendas });
});


router.get('/checkout',requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const tipoUsuario = req.session.usuario.tipo;

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
    return res.status(500).send('Erro ao carregar checkout');
  }

  res.render('checkout', { itens });
});


router.post('/checkout', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;        // COMPRADOR
  const tipoUsuario = req.session.usuario.tipo;    // 'pf' | 'pj'

  // 1) Busca itens do carrinho + dados necessários do produto (inclui loja_id)
  const { data: itens, error } = await supabaseDb
    .from('carrinho')
    .select(`
      id, produto_id, quantidade,
      produtos (
        id, nome, preco, imagem_url, quantidade, usuario_id, tipo_usuario, loja_id
      )
    `)
    .eq('usuario_id', usuarioId)
    .eq('tipo_usuario', tipoUsuario);

  if (error) {
    console.error('Erro carrinho:', error);
    return res.status(500).send('Erro ao finalizar compra');
  }
  if (!itens || itens.length === 0) {
    return res.status(400).send('Seu carrinho está vazio.');
  }

  // 2) Gera um código por loja (no mesmo checkout)
  const codigosPorLoja = {};
  const gerarCodigoPedido = (lojaId) => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    const rand = Math.floor(Math.random()*9000)+1000; // simples; troque por sequência se quiser
    return `L${(lojaId || '').toString().slice(0,4).toUpperCase()}-${y}${m}${day}-${rand}`;
  };

  // 3) Processa itens um a um, mas usando o MESMO codigo para itens da mesma loja
  for (const row of itens) {
    const prod = row.produtos; // atalho
    if (!prod) continue;

    // valida estoque
    const qtd = parseInt(row.quantidade, 10) || 1;
    if (prod.quantidade == null || prod.quantidade < qtd) {
      console.warn(`Estoque insuficiente para produto ${row.produto_id}. Em estoque: ${prod.quantidade}, pedido: ${qtd}`);
      continue;
    }

    // define codigo por loja
    const lojaId = prod.loja_id ?? null;
    if (!codigosPorLoja[lojaId || 'SEM_LOJA']) {
      codigosPorLoja[lojaId || 'SEM_LOJA'] = gerarCodigoPedido(lojaId || '0000');
    }
    const codigo = codigosPorLoja[lojaId || 'SEM_LOJA'];

    // monta payload
    const payloadPedido = {
      // comprador
      ...(tipoUsuario === 'pj' ? { comprador_pj_id: usuarioId } : { comprador_pf_id: usuarioId }),
      tipo_usuario: tipoUsuario,

      // vínculo com loja e produto
      loja_id: lojaId,
      produto_id: row.produto_id,
      quantidade: qtd,

      // valores
      preco_total: (Number(prod.preco) || 0) * qtd,

      // status e datas
      status: 'Em processamento',
      data_pedido: new Date(),

      // vendedor (de acordo com o produto)
      ...(prod.tipo_usuario === 'pj' ? { vendedor_pj_id: prod.usuario_id } : { vendedor_pf_id: prod.usuario_id }),

      // NOVO: mesmo codigo para itens da mesma loja
      codigo
    };

    // insere pedido (uma linha por item, compartilhando o mesmo codigo por loja)
    const { error: pedidoError } = await supabaseDb
      .from('pedidos')
      .insert([payloadPedido]);

    if (pedidoError) {
      console.error('Erro ao inserir pedido:', pedidoError);
      continue;
    }

    // decrementa estoque
    const { error: decErr } = await supabaseDb.rpc('decrementa_estoque', {
      p_id: row.produto_id,
      p_qtd: qtd
    });
    if (decErr) {
      console.error(`Erro ao decrementar estoque do produto ${row.produto_id}:`, decErr);
      // opcional: rollback manual do pedido inserido
    }
  }

  // 4) limpa carrinho
  const { error: delErr } = await supabaseDb
    .from('carrinho')
    .delete()
    .eq('usuario_id', usuarioId)
    .eq('tipo_usuario', tipoUsuario);

  if (delErr) console.error('Erro ao limpar carrinho:', delErr);

  // 5) redireciona
  res.redirect('/meus-pedidos');
});


router.post('/checkout/finalizar', requireLogin, async (req, res) => {
  try {
    const usuarioId   = req.session.usuario.id;
    const tipoUsuario = (req.session.usuario.tipo || '').toLowerCase(); // 'pf' | 'pj'
    const isPF        = (tipoUsuario === 'pf');

    // helper p/ código legível do pedido (L<4 chars loja>-AAAAMMDD-####)
    const gerarCodigoPedido = (lojaId) => {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      const rand = Math.floor(Math.random()*9000)+1000;
      const lojaPrefix = String(lojaId || '').replace(/-/g,'').slice(0,4).toUpperCase();
      return `L${lojaPrefix}-${y}${m}${day}-${rand}`;
    };

    // 1) Carrega itens do carrinho + metadados do produto (precisamos de loja_id, tipo_usuario e usuario_id do VENDEDOR)
    const { data: itensCarrinho, error } = await supabaseDb
      .from('carrinho')
      .select(`
        id, produto_id, quantidade,
        produtos (
          id, preco, usuario_id, tipo_usuario, loja_id, nome, imagem_url, quantidade
        )
      `)
      .eq('usuario_id', usuarioId)
      .eq('tipo_usuario', tipoUsuario);

    if (error) {
      console.error('[CHECKOUT] Erro carregando carrinho:', error);
      return res.status(500).send('Erro ao finalizar compra.');
    }
    if (!itensCarrinho?.length) {
      return res.status(400).send('Seu carrinho está vazio.');
    }

    // 2) Agrupa itens por loja (um pedido por loja)
    const porLoja = new Map();
    for (const row of itensCarrinho) {
      const prod = row.produtos;
      if (!prod) continue;

      const lojaId = prod.loja_id;
      if (!lojaId) {
        console.warn('[CHECKOUT] Produto sem loja_id, ignorando:', row.produto_id);
        continue;
      }

      // valida estoque básico (se a coluna existir e vier populada)
      const qtdCarrinho = Math.max(1, parseInt(row.quantidade, 10) || 1);
      if (prod.quantidade != null && Number(prod.quantidade) < qtdCarrinho) {
        console.warn('[CHECKOUT] Estoque insuficiente', {
          produto: row.produto_id, disponivel: prod.quantidade, solicitado: qtdCarrinho
        });
        return res.status(400).send('Um dos itens do carrinho está sem estoque suficiente.');
      }

      if (!porLoja.has(lojaId)) porLoja.set(lojaId, []);
      porLoja.get(lojaId).push({
        produto_id: row.produto_id,
        quantidade: qtdCarrinho,
        // pode omitir (a função busca do produto); enviar ajuda a evitar roundtrips
        preco: Number(prod.preco) || undefined,
        nome: prod.nome || undefined,
        imagem_url: (prod.imagem_url || '').split(',')[0] || undefined
      });
    }

    if (porLoja.size === 0) {
      return res.status(400).send('Não há itens válidos para finalizar.');
    }

    // 3) Cria os pedidos (um por loja) via RPC
    const pedidosCriados = [];
    for (const [lojaId, itens] of porLoja.entries()) {
      const codigo = gerarCodigoPedido(lojaId);

      const { data: pid, error: rpcErr } = await supabaseDb.rpc('create_pedido_with_itens', {
        _loja: lojaId,
        _status: 'criado',            // troque p/ 'em_processamento' se for seu fluxo
        _tipo_usuario: tipoUsuario, // do COMPRADOR: 'pf' | 'pj'
        _itens: itens,              // [{ produto_id, quantidade, preco?, nome?, imagem_url? }]
        _comprador_pf_id: isPF ? usuarioId : null,
        _comprador_pj_id: !isPF ? usuarioId : null,
        _codigo: codigo
      });

      if (rpcErr) {
        console.error(`[CHECKOUT] Erro criando pedido (loja ${lojaId}):`, rpcErr);
        // se quiser prosseguir com outras lojas, use "continue" aqui e acumule erros
        return res.status(500).send('Falha ao criar pedido. Tente novamente.');
      }

      pedidosCriados.push({ lojaId, pedidoId: pid, codigo });
    }

    // 4) Decrementa estoque (um por item do carrinho)
    for (const row of itensCarrinho) {
      const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);
      const { error: decErr } = await supabaseDb.rpc('decrementa_estoque', {
        p_id: row.produto_id,
        p_qtd: qtd
      });
      if (decErr) {
        console.error('[CHECKOUT] Erro decrementando estoque', row.produto_id, decErr);
        // segue o fluxo; opcional: acumular e exibir aviso ao usuário
      }
    }

    // 5) Limpa o carrinho do usuário
    const { error: delErr } = await supabaseDb
      .from('carrinho')
      .delete()
      .eq('usuario_id', usuarioId)
      .eq('tipo_usuario', tipoUsuario);
    if (delErr) {
      console.warn('[CHECKOUT] Carrinho não limpo (continuando mesmo assim):', delErr);
    }

    // 6) Redireciona
    console.log('Pedidos criados:', pedidosCriados);
    return res.redirect('/meus-pedidos');

  } catch (e) {
    console.error('Erro no checkout/finalizar:', e);
    return res.status(500).send('Erro ao finalizar compra.');
  }
});


// Util: normaliza string de status
function norm(v) { return String(v || '').trim().toLowerCase(); }

/**
 * POST /pedidos/avancar-status
 * Avança o status do pedido identificado por 'codigo' seguindo a tabela 'pedido_status_ref'
 */
router.post('/pedidos/avancar-status', requireLogin, async (req, res) => {
  try {
    const usuarioId = req.session?.usuario?.id;
    const { codigo, back } = req.body;
    const redirectTo = back || '/meus-pedidos';

    if (!codigo) {
      return res.redirect(redirectTo + '?err=codigo_vazio');
    }

    // 1) Busca o pedido pelo codigo
    const { data: pedido, error: errPedido } = await supabaseDb
      .from('pedidos')
      .select('id, codigo, status, comprador_pf_id, comprador_pj_id')
      .eq('codigo', codigo)
      .maybeSingle();

    if (errPedido) {
      console.error('Erro ao buscar pedido:', errPedido);
      return res.redirect(redirectTo + '?err=db_pedido');
    }
    if (!pedido) {
      return res.redirect(redirectTo + '?err=pedido_nao_encontrado');
    }

    // 2) (Segurança simples) — apenas o comprador pode avançar neste fluxo de TCC
    if (!(pedido.comprador_pf_id === usuarioId || pedido.comprador_pj_id === usuarioId)) {
      return res.redirect(redirectTo + '?err=sem_permissao');
    }

    // 3) Carrega o funil de status (pedido_status_ref), ordenado
    const { data: refs, error: errRefs } = await supabaseDb
      .from('pedido_status_ref')
      .select('status, rotulo, ordem_funnel')
      .order('ordem_funnel', { ascending: true });

    if (errRefs || !refs || !refs.length) {
      console.error('Erro ao buscar status_ref:', errRefs);
      return res.redirect(redirectTo + '?err=refs_indisponiveis');
    }

    // 4) Encontra o próximo status
    const curr = norm(pedido.status);
    const list = refs
      .map(r => ({ status: norm(r.status), ordem: Number(r.ordem_funnel), rotulo: r.rotulo }))
      .sort((a, b) => a.ordem - b.ordem);

    const currIdx = list.findIndex(s => s.status === curr);

    if (currIdx === -1) {
      // Status atual não faz parte do funil -> define como primeiro válido do funil
      const next = list[0];
      const { error: errUpd } = await supabaseDb
        .from('pedidos')
        .update({ status: next.status, updated_at: new Date().toISOString() })
        .eq('id', pedido.id);

      if (errUpd) {
        console.error('Erro update status:', errUpd);
        return res.redirect(redirectTo + '?err=update');
      }
      return res.redirect(redirectTo + '?ok=resetado_para_primeiro');
    }

    // Se já está no último status do funil, não avança
    if (currIdx >= list.length - 1) {
      return res.redirect(redirectTo + '?warn=ultimo_status');
    }

    const next = list[currIdx + 1];

    // (Opcional) bloqueios — ex.: não avançar para 'cancelado', 'estornado', 'chargeback' via este botão
    const bloqueados = new Set(['cancelado', 'estornado', 'chargeback']);
    if (bloqueados.has(next.status)) {
      return res.redirect(redirectTo + '?warn=bloqueado');
    }

    // 5) Atualiza status
    const { error: errUpd2 } = await supabaseDb
      .from('pedidos')
      .update({
        status: next.status,
        updated_at: new Date().toISOString()
      })
      .eq('id', pedido.id);

    if (errUpd2) {
      console.error('Erro update status:', errUpd2);
      return res.redirect(redirectTo + '?err=update');
    }

    return res.redirect(redirectTo + `?ok=avancado&novo=${encodeURIComponent(next.status)}`);
  } catch (e) {
    console.error(e);
    return res.redirect('/meus-pedidos?err=exception');
  }
});

module.exports = router;



module.exports = router
