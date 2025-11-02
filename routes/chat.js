const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb');
const { requireLogin } = require('../middlewares/auth');

router.get('/iniciar-chat/:produtoId', requireLogin, async (req, res) => {
  const { produtoId } = req.params;
  const usuarioAtual = req.session.usuario?.id;

  if (!usuarioAtual) {
    return res.redirect('/login');
  }

  // Buscar produto para saber o dono/vendedor
  const { data: produto, error: erroProduto } = await supabaseDb
    .from('produtos')
    .select('id, usuario_id')
    .eq('id', produtoId)
    .maybeSingle();

  if (erroProduto || !produto) {
    return res.status(404).send('Produto não encontrado');
  }

  const idVendedor = produto.usuario_id;

  // Verificar se já existe chat entre esses usuários para este produto
  const { data: chatExistente } = await supabaseDb
    .from('chats')
    .select('*')
    .eq('id_remetente', usuarioAtual)
    .eq('id_destinatario', idVendedor)
    .eq('produto_id', produtoId)
    .maybeSingle();

  let chatId;

  if (chatExistente) {
    chatId = chatExistente.id;
  } else {
    // Criar novo chat
    const { data: novoChat, error: erroChat } = await supabaseDb
      .from('chats')
      .insert([{
        id_remetente: usuarioAtual,
        id_destinatario: idVendedor,
        produto_id: produtoId
      }])
      .select()
      .single();

    if (erroChat) {
      console.error(erroChat);
      return res.status(500).send('Erro ao criar chat');
    }

    chatId = novoChat.id;
  }

  // Redirecionar para o chat correto
  res.redirect(`/chat/${chatId}`);
});

// routes/chat.js
router.get('/chat/:chatId', async (req, res) => {
  const { chatId } = req.params;
  const usuarioAtual = req.session.usuario?.id;

  if (!usuarioAtual) {
    return res.redirect('/login');
  }

  // 1. Buscar dados do chat atual e verificar se o usuário participa dele
  const { data: chat, error: erroChat } = await supabaseDb
    .from('chats')
    .select('*')
    .eq('id', chatId)
    .maybeSingle();

  if (erroChat || !chat) {
    return res.status(404).send('Chat não encontrado');
  }

  if (chat.id_remetente !== usuarioAtual && chat.id_destinatario !== usuarioAtual) {
    return res.status(403).send('Acesso negado a este chat');
  }

  // 2. Buscar produto relacionado (se existir)
  let produto = null;
  if (chat.produto_id) {
    const { data: produtoData } = await supabaseDb
      .from('produtos')
      .select('*')
      .eq('id', chat.produto_id)
      .maybeSingle();
    produto = produtoData || null;
  }

  // 3. Buscar mensagens do chat atual
  const { data: mensagens } = await supabaseDb
    .from('mensagens')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });

  // 4. Buscar info do outro participante (PF ou PJ)
  const outroUsuarioId = usuarioAtual === chat.id_remetente
    ? chat.id_destinatario
    : chat.id_remetente;

  let outroUsuario = null;

  // Tenta como PF
  const { data: pf } = await supabaseDb
    .from('usuarios_pf')
    .select('id, nome, icone_url')
    .eq('id', outroUsuarioId)
    .maybeSingle();

  if (pf) {
    outroUsuario = { nome: pf.nome, icone_url: pf.icone_url };
  } else {
    // Tenta como PJ
    const { data: pj } = await supabaseDb
      .from('usuarios_pj')
      .select('id, nomeFantasia, icone_url')
      .eq('id', outroUsuarioId)
      .maybeSingle();

    if (pj) {
      outroUsuario = { nome: pj.nomeFantasia, icone_url: pj.icone_url };
    }
  }

  if (!outroUsuario) {
    outroUsuario = { nome: 'Desconhecido', icone_url: null };
  }

  // 5. Buscar lista de todos os chats do usuário (para coluna lateral)
  const { data: todosChats } = await supabaseDb
    .from('chats')
    .select('*')
    .or(`id_remetente.eq.${usuarioAtual},id_destinatario.eq.${usuarioAtual}`);

  const listaChats = await Promise.all(
    (todosChats || []).map(async (c) => {
      const outroId = c.id_remetente === usuarioAtual ? c.id_destinatario : c.id_remetente;

      let outroUser = null;

      const { data: pfUser } = await supabaseDb
        .from('usuarios_pf')
        .select('nome, icone_url')
        .eq('id', outroId)
        .maybeSingle();

      if (pfUser) {
        outroUser = { nome: pfUser.nome, icone_url: pfUser.icone_url };
      } else {
        const { data: pjUser } = await supabaseDb
          .from('usuarios_pj')
          .select('nomeFantasia, icone_url')
          .eq('id', outroId)
          .maybeSingle();

        if (pjUser) {
          outroUser = { nome: pjUser.nomeFantasia, icone_url: pjUser.icone_url };
        }
      }

      return {
        chat_id: c.id,
        outroUsuario: outroUser || { nome: 'Desconhecido', icone_url: null }
      };
    })
  );

  // 6. Renderizar página
  res.render('chat', {
    chatId,
    produto,
    mensagens: mensagens || [],
    usuarioAtual,
    outroUsuario,
    listaChats,
    meuUsuario: req.session.usuario // opcional: dados do próprio usuário
  });
});



router.get('/meus-chats', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;

  const { data: chats, error: errorChats } = await supabaseDb
    .from('chats')
    .select('*')
    .or(`id_remetente.eq.${usuarioId},id_destinatario.eq.${usuarioId}`);

  if (errorChats) {
    console.error(errorChats);
    return res.status(500).send('Erro ao buscar chats.');
  }

  const chatsCompletos = await Promise.all(
    chats.map(async (chat) => {
      const outroId = chat.id_remetente === usuarioId ? chat.id_destinatario : chat.id_remetente;

      const { data: ultimaMsg } = await supabaseDb
        .from('mensagens')
        .select('*')
        .eq('chat_id', chat.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let outroUsuario = null;

      const { data: pf } = await supabaseDb
        .from('usuarios_pf')
        .select('nome, icone_url')
        .eq('id', outroId)
        .maybeSingle();

      if (pf) {
        outroUsuario = pf;
      } else {
        const { data: pj } = await supabaseDb
          .from('usuarios_pj')
          .select('nomeFantasia, icone_url')
          .eq('id', outroId)
          .maybeSingle();

        if (pj) {
          outroUsuario = { nome: pj.nomeFantasia, icone_url: pj.icone_url };
        }
      }

      let produtoInfo = null;
      if (chat.produto_id) {
        const { data: produto } = await supabaseDb
          .from('produtos')
          .select('nome, imagem_url')
          .eq('id', chat.produto_id)
          .maybeSingle();

        if (produto) {
          produtoInfo = {
            nome: produto.nome,
            imagem_url: produto.imagem_url?.split(',')[0] || null
          };
        }
      }

      return {
        chat_id: chat.id,
        outroUsuario: outroUsuario || { nome: 'Desconhecido', icone_url: null },
        produto: produtoInfo,
        ultimaMensagem: ultimaMsg ? ultimaMsg.mensagem : null,
        ultimaMensagemData: ultimaMsg ? ultimaMsg.created_at : null
      };
    })
  );

  res.render('meus-chats', { chats: chatsCompletos });
});


router.post('/mensagens/enviar', requireLogin, async (req, res) => {
  const { chat_id, mensagem } = req.body;
  const usuarioAtual = req.session.usuario?.id;

  // evita vazios
  const texto = (mensagem || '').trim();
  if (!texto) {
    return res.redirect(`/chat/${chat_id}`);
  }

  // valida participação no chat
  const { data: chat, error: chatErr } = await supabaseDb
    .from('chats')
    .select('id, id_remetente, id_destinatario')
    .eq('id', chat_id)
    .maybeSingle();

  if (chatErr || !chat) {
    console.error(chatErr);
    return res.status(404).send('Chat não encontrado');
  }

  if (chat.id_remetente !== usuarioAtual && chat.id_destinatario !== usuarioAtual) {
    return res.status(403).send('Você não participa deste chat');
  }

  const { error } = await supabaseDb
    .from('mensagens')
    .insert([{
      chat_id,
      id_remetente: usuarioAtual,
      mensagem: texto
    }]);

  if (error) {
    console.error(error);
    return res.status(500).send('Erro ao enviar mensagem');
  }

  res.redirect(`/chat/${chat_id}`);
});


module.exports = router;
