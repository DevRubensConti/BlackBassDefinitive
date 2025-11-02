// middlewares/requireLoja.js
const supabaseDb = require('../supabase/supabaseDb');

async function requireLoja(req, res, next) {
  try {
    const sess = req.session?.usuario;
    if (!sess) return res.status(401).send('Não autenticado.');

    const tipo = String(sess.tipo || '').toUpperCase(); // 'PF' | 'PJ'
    if (!['PF','PJ'].includes(tipo)) {
      return res.status(400).send('Tipo de usuário inválido na sessão.');
    }

    const table = tipo === 'PJ' ? 'usuarios_pj' : 'usuarios_pf';

    // 1) Ler o loja_id nas tabelas de usuários
    const { data: usuario, error: errU } = await supabaseDb
      .from(table)
      .select('loja_id')
      .eq('id', sess.id)
      .single();

    if (errU) return res.status(500).json({ error: errU });
    if (!usuario?.loja_id) return res.status(403).send('Seu usuário não está vinculado a nenhuma loja.');

    const lojaId = usuario.loja_id;

    // 2) Carregar a loja. Alias para bater com EJS (nomeFantasia)
    const { data: loja, error: errL } = await supabaseDb
      .from('lojas')
      .select('id, nomeFantasia:nome_fantasia, nome_fantasia, cidade, estado, icone_url, taxa_comissao_pct')
      .eq('id', lojaId)
      .single();

    if (errL) return res.status(500).json({ error: errL });
    if (!loja) return res.status(404).send('Loja não encontrada.');

    // Cache opcional
    req.session.loja_id = loja.id;
    req.loja = loja; // agora suas rotas podem usar req.loja.id e req.loja.nomeFantasia
    next();
  } catch (e) {
    console.error('requireLoja erro:', e);
    return res.status(500).send('Falha ao identificar a loja do usuário.');
  }
}

module.exports = requireLoja;
