const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { requireLogin } = require('../middlewares/auth');
const {
  inserirFreteNoCarrinho,
  checkoutFretes,
  gerarEtiquetas,
  refreshAccessToken
} = require('../services/melhorEnvio');



// =============================
// Helper: token do Melhor Envio por loja (com refresh)
// =============================
async function getValidAccessTokenForLoja(lojaId) {
  const { data: row, error } = await supabaseDb
    .from('melhorenvio_tokens')
    .select('access_token, refresh_token, expires_in, token_type, created_at, expires_at')
    .eq('loja_id', lojaId)
    .maybeSingle();

  if (error) {
    console.error('[PEDIDOS][ME][TOKEN] Erro ao buscar token no Supabase:', error);
    throw new Error('Erro ao buscar token do Melhor Envio.');
  }

  if (!row || !row.access_token) {
    throw new Error('Nenhum token do Melhor Envio encontrado para esta loja.');
  }

  const now = Date.now();

  let expiresAtMs;
  if (row.expires_at) {
    // Novo formato (recomendado): coluna expires_at
    expiresAtMs = new Date(row.expires_at).getTime();
  } else {
    // Formato legado: usa created_at + expires_in
    const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : now;
    const expiresInMs = (row.expires_in || 3600) * 1000;
    expiresAtMs = createdAtMs + expiresInMs;
  }

  // Renova se faltam menos de 5 minutos para expirar
  const willExpireSoon = !expiresAtMs || now > expiresAtMs - 5 * 60 * 1000;

  if (!willExpireSoon || !row.refresh_token) {
    return row.access_token;
  }

  console.log('[PEDIDOS][ME][TOKEN] Token próximo de expirar. Renovando via refresh_token…');

  const newTokens = await refreshAccessToken(row.refresh_token);

  const expiresAt = new Date(
    Date.now() + (newTokens.expires_in || row.expires_in || 3600) * 1000
  ).toISOString();

  const { error: upsertErr } = await supabaseDb
    .from('melhorenvio_tokens')
    .upsert(
      {
        loja_id: lojaId,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || row.refresh_token,
        expires_in: newTokens.expires_in || row.expires_in,
        token_type: newTokens.token_type || row.token_type || 'Bearer',
        created_at: new Date().toISOString(),
        expires_at: expiresAt
      },
      { onConflict: 'loja_id' }
    );

  if (upsertErr) {
    console.error('[PEDIDOS][ME][TOKEN] Erro ao salvar token renovado no Supabase:', upsertErr);
    throw new Error('Erro ao salvar token renovado do Melhor Envio.');
  }

  console.log('[PEDIDOS][ME][TOKEN] Token renovado com sucesso para loja:', lojaId);
  return newTokens.access_token;
}

// =============================
// Helper: criar+checkout+gerar etiqueta para um pedido
// =============================
// =============================
// Helper: criar+checkout+gerar etiqueta para um pedido
// =============================
async function criarGerarEtiquetaParaPedido(pedidoId) {
  // 1) Pedido
  const { data: pedido, error: pedErr } = await supabaseDb
    .from('pedidos')
    .select('id, codigo, loja_id, tipo_usuario, comprador_pf_id, comprador_pj_id, preco_total, vendedor_pf_id, vendedor_pj_id')
    .eq('id', pedidoId)
    .maybeSingle();

  if (pedErr || !pedido) {
    console.error('[ME][PEDIDO] Erro ao buscar pedido para etiqueta:', pedErr);
    throw new Error('Pedido não encontrado para geração de etiqueta.');
  }

  const lojaId = pedido.loja_id;
  if (!lojaId) {
    throw new Error('Pedido sem loja associada para geração de etiqueta.');
  }

  const accessToken = await getValidAccessTokenForLoja(lojaId);

  // 2) Loja + remetente (dono da loja)
  const { data: lojaRow, error: lojaErr } = await supabaseDb
    .from('lojas')
    .select('id, usuario_id, doc_tipo, nome_fantasia, cidade, estado')
    .eq('id', lojaId)
    .maybeSingle();

  if (lojaErr || !lojaRow) {
    console.error('[ME][PEDIDO] Erro ao buscar loja para etiqueta:', lojaErr);
    throw new Error('Loja não encontrada para o pedido.');
  }

  const docTipo = (lojaRow.doc_tipo || '').toUpperCase();
  let remetente;

  if (docTipo === 'CNPJ') {
    const { data: pj, error: pjErr } = await supabaseDb
      .from('usuarios_pj')
      .select('cnpj, cpf_responsavel, email, "nomeFantasia", "razaoSocial", telefone, cep, endereco, numero, bairro, complemento, cidade, estado')
      .eq('id', lojaRow.usuario_id)
      .maybeSingle();

    if (pjErr || !pj) {
      console.error('[ME][PEDIDO] Erro dados remetente PJ:', pjErr);
      throw new Error('Dados de remetente PJ não encontrados.');
    }

    remetente = {
      name: pj.nomeFantasia || pj.razaoSocial || 'Remetente',
      phone: pj.telefone || '',
      email: pj.email || '',
      // CPF do responsável (campo novo) – Melhor Envio exige CPF aqui
      document: String(pj.cpf_responsavel || pj.cnpj || '').replace(/\D+/g, ''),
      // CNPJ da empresa
      company_document: String(pj.cnpj || '').replace(/\D+/g, ''),
      postal_code: String(pj.cep || '').replace(/\D+/g, ''),
      address: pj.endereco || '',
      number: pj.numero || '',
      complement: pj.complemento || '',
      district: pj.bairro || '',
      city: pj.cidade || '',
      state_abbr: pj.estado || '',
      country_id: 'BR'
    };
  } else {
    const { data: pf, error: pfErr } = await supabaseDb
      .from('usuarios_pf')
      .select('nome, sobrenome, cpf, email, telefone, cep, endereco, numero, bairro, complemento, cidade, estado')
      .eq('id', lojaRow.usuario_id)
      .maybeSingle();

    if (pfErr || !pf) {
      console.error('[ME][PEDIDO] Erro dados remetente PF:', pfErr);
      throw new Error('Dados de remetente PF não encontrados.');
    }

    remetente = {
      name: `${pf.nome || ''} ${pf.sobrenome || ''}`.trim() || 'Remetente',
      phone: pf.telefone || '',
      email: pf.email || '',
      document: String(pf.cpf || '').replace(/\D+/g, ''),
      postal_code: String(pf.cep || '').replace(/\D+/g, ''),
      address: pf.endereco || '',
      number: pf.numero || '',
      complement: pf.complemento || '',
      district: pf.bairro || '',
      city: pf.cidade || '',
      state_abbr: pf.estado || '',
      country_id: 'BR'
    };
  }

  // 3) Destinatário (comprador)
  let destinatario;
  const tipoComprador = (pedido.tipo_usuario || '').toLowerCase();

  if (tipoComprador === 'pj') {
    const { data: pjComp, error: pjCompErr } = await supabaseDb
      .from('usuarios_pj')
      .select('cnpj, cpf_responsavel, email, "nomeFantasia", "razaoSocial", telefone, cep, endereco, numero, bairro, complemento, cidade, estado')
      .eq('id', pedido.comprador_pj_id)
      .maybeSingle();

    if (pjCompErr || !pjComp) {
      console.error('[ME][PEDIDO] Erro dados destinatário PJ:', pjCompErr);
      throw new Error('Dados de destinatário PJ não encontrados.');
    }

    destinatario = {
      name: pjComp.nomeFantasia || pjComp.razaoSocial || 'Destinatário',
      phone: pjComp.telefone || '',
      email: pjComp.email || '',
      // CPF do responsável como documento pessoal; fallback para CNPJ se faltar
      document: String(pjComp.cpf_responsavel || pjComp.cnpj || '').replace(/\D+/g, ''),
      company_document: String(pjComp.cnpj || '').replace(/\D+/g, ''),
      postal_code: String(pjComp.cep || '').replace(/\D+/g, ''),
      address: pjComp.endereco || '',
      number: pjComp.numero || '',
      complement: pjComp.complemento || '',
      district: pjComp.bairro || '',
      city: pjComp.cidade || '',
      state_abbr: pjComp.estado || '',
      country_id: 'BR'
    };
  } else {
    const { data: pfComp, error: pfCompErr } = await supabaseDb
      .from('usuarios_pf')
      .select('nome, sobrenome, cpf, email, telefone, cep, endereco, numero, bairro, complemento, cidade, estado')
      .eq('id', pedido.comprador_pf_id)
      .maybeSingle();

    if (pfCompErr || !pfComp) {
      console.error('[ME][PEDIDO] Erro dados destinatário PF:', pfCompErr);
      throw new Error('Dados de destinatário PF não encontrados.');
    }

    destinatario = {
      name: `${pfComp.nome || ''} ${pfComp.sobrenome || ''}`.trim() || 'Destinatário',
      phone: pfComp.telefone || '',
      email: pfComp.email || '',
      document: String(pfComp.cpf || '').replace(/\D+/g, ''),
      postal_code: String(pfComp.cep || '').replace(/\D+/g, ''),
      address: pfComp.endereco || '',
      number: pfComp.numero || '',
      complement: pfComp.complemento || '',
      district: pfComp.bairro || '',
      city: pfComp.cidade || '',
      state_abbr: pfComp.estado || '',
      country_id: 'BR'
    };
  }

  // 4) Itens do pedido
  const { data: itens, error: itensErr } = await supabaseDb
    .from('pedido_itens')
    .select('produto_id, quantidade, nome, unit_price_cents, subtotal_cents')
    .eq('pedido_id', pedidoId);

  if (itensErr || !itens || !itens.length) {
    console.error('[ME][PEDIDO] Erro ao buscar itens do pedido:', itensErr);
    throw new Error('Itens do pedido não encontrados para etiqueta.');
  }

  // Produtos no formato exigido pelo Melhor Envio
  const products = itens.map((it) => {
    const unitario = Number(it.unit_price_cents || 0) / 100;
    const subtotal = Number(it.subtotal_cents || 0) / 100;

    return {
      id: it.produto_id,
      name: it.nome || 'Produto',
      quantity: Number(it.quantidade || 1),
      unitary_value: unitario,
      weight: 4,               // kg por unidade (ajusta se quiser)
      insurance_value: subtotal
    };
  });

  const totalInsurance = products.reduce((acc, p) => acc + (p.insurance_value || 0), 0);
  const totalWeight = products.reduce((acc, p) => acc + (p.weight || 0) * p.quantity, 0);
  const serviceId = Number(process.env.MELHOR_ENVIO_DEFAULT_SERVICE_ID || 3);

  const payloadCart = {
    service: serviceId,
    from: remetente,
    to: destinatario,
    products, // 🔥 agora vai com name + unitary_value + etc
    volumes: [
      {
        format: 'box',
        height: 24,
        width: 38,
        length: 102,
        weight: totalWeight,
        insurance_value: totalInsurance
      }
    ],
    options: {
      receipt: false,
      own_hand: false,
      collect: false
    }
  };

  console.log(
    '[ME][PEDIDO] Payload carrinho para pedido',
    pedidoId,
    JSON.stringify(payloadCart, null, 2)
  );

  // 5) /me/cart
  const cartResp = await inserirFreteNoCarrinho(accessToken, payloadCart);

  const shipmentId =
    (Array.isArray(cartResp) && cartResp[0] && (cartResp[0].id || cartResp[0].shipment_id)) ||
    cartResp.id ||
    cartResp.shipment_id;

  if (!shipmentId) {
    console.error('[ME][PEDIDO] Resposta /cart sem shipmentId reconhecível:', cartResp);
    throw new Error('Não foi possível identificar o ID do envio retornado pelo Melhor Envio.');
  }

  // Infos da transportadora/serviço (se vierem no /cart)
  let companyName = null;
  let serviceName = null;
  if (Array.isArray(cartResp) && cartResp[0]) {
    const s = cartResp[0];
    companyName = s.company?.name || null;
    serviceName = s.service || s.name || null;
  } else if (cartResp.company) {
    companyName = cartResp.company.name || null;
    serviceName = cartResp.service || cartResp.name || null;
  }

  // 6) checkout
  const checkoutResp = await checkoutFretes(accessToken, [shipmentId]);
  console.log('[ME][PEDIDO] Checkout etiquetas OK para', shipmentId, checkoutResp);

  // 7) gerar etiquetas
  const generateResp = await gerarEtiquetas(accessToken, [shipmentId]);
  console.log('[ME][PEDIDO] Geração de etiquetas OK para', shipmentId, generateResp);

  // 8) Tenta achar URL da etiqueta (formato pode variar)
  let labelUrl = null;
  if (Array.isArray(generateResp) && generateResp[0]) {
    const g = generateResp[0];
    labelUrl = g.label_url || g.label || g.url || g.file || null;
  } else if (generateResp && typeof generateResp === 'object') {
    labelUrl = generateResp.label_url || generateResp.label || generateResp.url || generateResp.file || null;
  }

  // 9) Atualiza o pedido no banco
  try {
    await supabaseDb
      .from('pedidos')
      .update({
        me_order_id: shipmentId,
        me_service_id: serviceId,
        me_label_url: labelUrl,
        me_company: companyName,
        me_service: serviceName,
        me_label_payload: generateResp
      })
      .eq('id', pedidoId);

    console.log('[ME][PEDIDO] Campos de etiqueta atualizados no pedido', pedidoId);
  } catch (e) {
    console.error('[ME][PEDIDO] Erro ao atualizar pedido com dados de etiqueta:', e);
  }

  return {
    shipmentId,
    cartResp,
    checkoutResp,
    generateResp,
    companyName,
    serviceName,
    labelUrl
  };
}

// =============================
// MEUS PEDIDOS (comprador)
// =============================
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
    const { data: itens, error: itensErr } = await supabaseDb
      .from('pedido_itens')
      .select('id, pedido_id, produto_id, nome, imagem_url, quantidade, unit_price_cents, subtotal_cents')
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
        // IDs essenciais para botões/links
        pedido_item_id: it.id,
        pedido_id: it.pedido_id,
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

      // Anexa itens deste pedido
      const itensDoPedido = itensByPedido[p.id] || [];
      gruposMap[key].itens.push(...itensDoPedido);

      // Mantém data/status do mais recente
      if (new Date(p.data_pedido) > new Date(gruposMap[key].data)) {
        gruposMap[key].data = p.data_pedido;
        gruposMap[key].status = p.status;
      }

      // Se quiser somar totals de múltiplos cabeçalhos com o mesmo código:
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

// =============================
// MINHAS VENDAS (vendedor)
// =============================
router.get('/minhas-vendas', requireLogin, async (req, res) => {
  const vendedorId = req.session.usuario.id;

  try {
    // 1) Buscar pedidos onde eu sou o vendedor (PF ou PJ)
    const { data: pedidos, error: pedErr } = await supabaseDb
      .from('pedidos')
      .select(`
        id,
        codigo,
        status,
        data_pedido,
        preco_total,
        vendedor_pf_id,
        vendedor_pj_id,
        loja_id,
        me_order_id,
        me_label_url,
        me_company,
        me_service
      `)
      .or(`vendedor_pf_id.eq.${vendedorId},vendedor_pj_id.eq.${vendedorId}`)
      .order('data_pedido', { ascending: false });

    if (pedErr) {
      console.error('Erro ao buscar pedidos do vendedor:', pedErr);
      return res.status(500).send('Erro ao buscar suas vendas');
    }
    if (!pedidos?.length) {
      return res.render('minhas-vendas', { vendas: [] });
    }

    const pedidoIds = pedidos.map(p => p.id);

    // 2) Trazer os ITENS de cada pedido (sem join automático)
    const { data: itens, error: itensErr } = await supabaseDb
      .from('pedido_itens')
      .select(`
        id,
        pedido_id,
        produto_id,
        nome,
        imagem_url,
        quantidade,
        unit_price_cents,
        subtotal_cents
      `)
      .in('pedido_id', pedidoIds);

    if (itensErr) {
      console.error('Erro ao buscar itens das vendas:', itensErr);
      return res.status(500).send('Erro ao buscar itens das vendas');
    }

    // 2.1) Buscar produtos relacionados (pra saber dono, loja, imagem etc.)
    const produtoIds = [...new Set((itens || []).map(it => it.produto_id).filter(Boolean))];

    let prodById = {};
    if (produtoIds.length) {
      const { data: produtos, error: prodErr } = await supabaseDb
        .from('produtos')
        .select('id, usuario_id, tipo_usuario, loja_id, imagem_url')
        .in('id', produtoIds);

      if (prodErr) {
        console.error('Erro ao buscar produtos das vendas:', prodErr);
      } else {
        prodById = Object.fromEntries(
          (produtos || []).map(p => [p.id, p])
        );
      }
    }

    // 3) Manter só itens cujos produtos pertencem a este vendedor (por segurança)
    const meusItens = (itens || []).filter(it => {
      const prod = prodById[it.produto_id];
      const dono = prod?.usuario_id;
      return String(dono) === String(vendedorId);
    });

    // 4) Agregar itens por pedido_id p/ exibição
    const itensByPedido = {};
    for (const it of meusItens) {
      if (!itensByPedido[it.pedido_id]) itensByPedido[it.pedido_id] = [];

      const prod = prodById[it.produto_id] || {};
      const img =
        it.imagem_url ||
        (prod.imagem_url || '').split(',')[0] ||
        '/images/placeholder.png';

      itensByPedido[it.pedido_id].push({
        pedido_item_id: it.id,
        produto_id: it.produto_id,
        nome: it.nome || '(sem nome)',
        imagem_url: img,
        quantidade: Number(it.quantidade || 0),
        unitario: Number(it.unit_price_cents || 0) / 100,
        subtotal: Number(it.subtotal_cents || 0) / 100
      });
    }

    // 5) Montar “vendas” (cabeçalho + itens)
    const vendas = pedidos.map(p => ({
      id: p.id,
      codigo: p.codigo,
      status: p.status,
      data: p.data_pedido,
      total: Number(p.preco_total || 0),
      loja_id: p.loja_id,
      itens: itensByPedido[p.id] || [],
      me_order_id: p.me_order_id || null,
      me_label_url: p.me_label_url || null,
      me_company: p.me_company || null,
      me_service: p.me_service || null
    }));

    return res.render('minhas-vendas', { vendas });
  } catch (err) {
    console.error('Erro geral /minhas-vendas:', err);
    return res.status(500).send('Erro ao buscar suas vendas');
  }
});

// Geração de etiqueta para um pedido (minhas vendas)
router.post('/minhas-vendas/:pedidoId/gerar-etiqueta', requireLogin, async (req, res) => {
  try {
    const vendedorId = req.session.usuario.id;
    const pedidoId = req.params.pedidoId;

    // 1) Validar se o pedido é seu
    const { data: pedido, error: pedErr } = await supabaseDb
      .from('pedidos')
      .select('id, codigo, loja_id, vendedor_pf_id, vendedor_pj_id')
      .eq('id', pedidoId)
      .maybeSingle();

    if (pedErr) {
      console.error('[ETIQUETA] Erro ao buscar pedido:', pedErr);
      return res.status(500).send('Erro ao buscar pedido');
    }
    if (!pedido) {
      return res.status(404).send('Pedido não encontrado');
    }

    if (
      String(pedido.vendedor_pf_id || '') !== String(vendedorId) &&
      String(pedido.vendedor_pj_id || '') !== String(vendedorId)
    ) {
      return res.status(403).send('Você não tem permissão para gerar etiqueta deste pedido.');
    }

    // 2) Chama o helper que faz todo o fluxo e já atualiza o pedido
    const result = await criarGerarEtiquetaParaPedido(pedidoId);

    console.log('[ETIQUETA] Gerada com sucesso para pedido', pedidoId, '->', result.shipmentId);

    return res.redirect('/minhas-vendas?ok=etiqueta_gerada');
  } catch (err) {
    console.error('[ETIQUETA] Erro geral ao gerar etiqueta:', err);
    return res.status(500).send('Erro ao gerar etiqueta.');
  }
});


// =============================
// CHECKOUT (página)
// =============================
router.get('/checkout', requireLogin, async (req, res) => {
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

// =============================
// CHECKOUT (fluxos antigos/alternativos)
// =============================
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

  const codigosPorLoja = {};
  const gerarCodigoPedido = (lojaId) => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    const rand = Math.floor(Math.random()*9000)+1000;
    return `L${(lojaId || '').toString().slice(0,4).toUpperCase()}-${y}${m}${day}-${rand}`;
  };

  for (const row of itens) {
    const prod = row.produtos;
    if (!prod) continue;

    const qtd = parseInt(row.quantidade, 10) || 1;
    if (prod.quantidade == null || prod.quantidade < qtd) {
      console.warn(`Estoque insuficiente para produto ${row.produto_id}. Em estoque: ${prod.quantidade}, pedido: ${qtd}`);
      continue;
    }

    const lojaId = prod.loja_id ?? null;
    if (!codigosPorLoja[lojaId || 'SEM_LOJA']) {
      codigosPorLoja[lojaId || 'SEM_LOJA'] = gerarCodigoPedido(lojaId || '0000');
    }
    const codigo = codigosPorLoja[lojaId || 'SEM_LOJA'];

    const payloadPedido = {
      ...(tipoUsuario === 'pj' ? { comprador_pj_id: usuarioId } : { comprador_pf_id: usuarioId }),
      tipo_usuario: tipoUsuario,
      loja_id: lojaId,
      produto_id: row.produto_id,
      quantidade: qtd,
      preco_total: (Number(prod.preco) || 0) * qtd,
      status: 'Em processamento',
      data_pedido: new Date(),
      ...(prod.tipo_usuario === 'pj' ? { vendedor_pj_id: prod.usuario_id } : { vendedor_pf_id: prod.usuario_id }),
      codigo
    };

    const { error: pedidoError } = await supabaseDb
      .from('pedidos')
      .insert([payloadPedido]);

    if (pedidoError) {
      console.error('Erro ao inserir pedido:', pedidoError);
      continue;
    }

    const { error: decErr } = await supabaseDb.rpc('decrementa_estoque', {
      p_id: row.produto_id,
      p_qtd: qtd
    });
    if (decErr) {
      console.error(`Erro ao decrementar estoque do produto ${row.produto_id}:`, decErr);
    }
  }

  const { error: delErr } = await supabaseDb
    .from('carrinho')
    .delete()
    .eq('usuario_id', usuarioId)
    .eq('tipo_usuario', tipoUsuario);

  if (delErr) console.error('Erro ao limpar carrinho:', delErr);

  res.redirect('/meus-pedidos');
});

// =============================
// CHECKOUT (RPC com itens)
// =============================
router.post('/checkout/finalizar', requireLogin, async (req, res) => {
  try {
    const usuarioId   = req.session.usuario.id;
    const tipoUsuario = (req.session.usuario.tipo || '').toLowerCase(); // 'pf' | 'pj'
    const isPF        = (tipoUsuario === 'pf');

    const gerarCodigoPedido = (lojaId) => {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      const rand = Math.floor(Math.random()*9000)+1000;
      const lojaPrefix = String(lojaId || '').replace(/-/g,'').slice(0,4).toUpperCase();
      return `L${lojaPrefix}-${y}${m}${day}-${rand}`;
    };

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

    const porLoja = new Map();
    for (const row of itensCarrinho) {
      const prod = row.produtos;
      if (!prod) continue;

      const lojaId = prod.loja_id;
      if (!lojaId) {
        console.warn('[CHECKOUT] Produto sem loja_id, ignorando:', row.produto_id);
        continue;
      }

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
        preco: Number(prod.preco) || undefined,
        nome: prod.nome || undefined,
        imagem_url: (prod.imagem_url || '').split(',')[0] || undefined
      });
    }

    if (porLoja.size === 0) {
      return res.status(400).send('Não há itens válidos para finalizar.');
    }

    const pedidosCriados = [];
    for (const [lojaId, itens] of porLoja.entries()) {
      const codigo = gerarCodigoPedido(lojaId);

      const { data: pid, error: rpcErr } = await supabaseDb.rpc('create_pedido_with_itens', {
        _loja: lojaId,
        _status: 'criado',
        _tipo_usuario: tipoUsuario,
        _itens: itens,
        _comprador_pf_id: isPF ? usuarioId : null,
        _comprador_pj_id: !isPF ? usuarioId : null,
        _codigo: codigo
      });

      if (rpcErr) {
        console.error(`[CHECKOUT] Erro criando pedido (loja ${lojaId}):`, rpcErr);
        return res.status(500).send('Falha ao criar pedido. Tente novamente.');
      }

      pedidosCriados.push({ lojaId, pedidoId: pid, codigo });
    }

    for (const row of itensCarrinho) {
      const qtd = Math.max(1, parseInt(row.quantidade, 10) || 1);
      const { error: decErr } = await supabaseDb.rpc('decrementa_estoque', {
        p_id: row.produto_id,
        p_qtd: qtd
      });
      if (decErr) {
        console.error('[CHECKOUT] Erro decrementando estoque', row.produto_id, decErr);
      }
    }

    const { error: delErr } = await supabaseDb
      .from('carrinho')
      .delete()
      .eq('usuario_id', usuarioId)
      .eq('tipo_usuario', tipoUsuario);
    if (delErr) {
      console.warn('[CHECKOUT] Carrinho não limpo (continuando mesmo assim):', delErr);
    }

    console.log('Pedidos criados:', pedidosCriados);
    return res.redirect('/meus-pedidos');

  } catch (e) {
    console.error('Erro no checkout/finalizar:', e);
    return res.status(500).send('Erro ao finalizar compra.');
  }
});

// =============================
// Avançar status do pedido
// =============================
function norm(v) { return String(v || '').trim().toLowerCase(); }

router.post('/pedidos/avancar-status', requireLogin, async (req, res) => {
  try {
    const usuarioId = req.session?.usuario?.id;
    const { codigo, back } = req.body;
    const redirectTo = back || '/meus-pedidos';

    if (!codigo) {
      return res.redirect(redirectTo + '?err=codigo_vazio');
    }

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

    if (!(pedido.comprador_pf_id === usuarioId || pedido.comprador_pj_id === usuarioId)) {
      return res.redirect(redirectTo + '?err=sem_permissao');
    }

    const { data: refs, error: errRefs } = await supabaseDb
      .from('pedido_status_ref')
      .select('status, rotulo, ordem_funnel')
      .order('ordem_funnel', { ascending: true });

    if (errRefs || !refs || !refs.length) {
      console.error('Erro ao buscar status_ref:', errRefs);
      return res.redirect(redirectTo + '?err=refs_indisponiveis');
    }

    const curr = norm(pedido.status);
    const list = refs
      .map(r => ({ status: norm(r.status), ordem: Number(r.ordem_funnel), rotulo: r.rotulo }))
      .sort((a, b) => a.ordem - b.ordem);

    const currIdx = list.findIndex(s => s.status === curr);

    if (currIdx === -1) {
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

    if (currIdx >= list.length - 1) {
      return res.redirect(redirectTo + '?warn=ultimo_status');
    }

    const next = list[currIdx + 1];

    const bloqueados = new Set(['cancelado', 'estornado', 'chargeback']);
    if (bloqueados.has(next.status)) {
      return res.redirect(redirectTo + '?warn=bloqueado');
    }

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
