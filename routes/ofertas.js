const express = require('express');
const router = express.Router();
const supabaseDb = require('../supabase/supabaseDb'); // SERVICE ROLE (DB)
const { requireLogin } = require('../middlewares/auth'); // seu middleware

router.post('/api/ofertas', requireLogin, async (req, res) => {
  try {
    const comprador = req.session.usuario;
    const { produto_id, valor, mensagem } = req.body;

    if (!produto_id || !valor || Number(valor) <= 0) {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }

    // (Opcional) valida se produto existe/ativo
    const { data: produto, error: prodErr } = await supabaseDb
      .from('produtos')
      .select('id, usuario_id, tipo_usuario, preco')
      .eq('id', produto_id)
      .single();
    if (prodErr || !produto) {
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }

    // Impede oferta do próprio dono
    if (produto.usuario_id === comprador.id) {
      return res.status(403).json({ error: 'Você não pode ofertar no próprio produto.' });
    }

    const { error: insertErr } = await supabaseDb
      .from('ofertas')
      .insert({
        produto_id,
        comprador_id: comprador.id,
        valor: Number(valor),
        mensagem: mensagem || null,
        status: 'pendente'
      });

    if (insertErr) throw insertErr;

    // TODO (opcional): criar notificação interna para o vendedor
    // await supabaseDb.from('notificacoes').insert({
    //   usuario_id: produto.usuario_id,
    //   titulo: 'Nova oferta recebida',
    //   mensagem: `Você recebeu uma oferta em seu produto.`
    // });

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('Erro ao criar oferta:', e);
    return res.status(500).json({ error: 'Falha ao criar oferta.' });
  }
});

module.exports = router;
