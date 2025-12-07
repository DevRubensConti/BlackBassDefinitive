// middlewares/subscription.js
const supabaseDb = require('../supabase/supabaseDb');

async function requireActiveSubscription(req, res, next) {
  try {
    const usuario = req.session?.usuario;
    if (!usuario) return res.redirect('/login');

    const { data: sub, error } = await supabaseDb
      .from('assinaturas')
      .select('*')
      .eq('usuario_id', usuario.id)
      .in('status', ['authorized', 'active'])
      .maybeSingle();

    if (error || !sub) {
      return res.redirect('/planos?err=sem_assinatura');
    }

    next();
  } catch (e) {
    console.error('[SUBS][MIDDLEWARE] Erro:', e);
    return res.status(500).send('Erro ao validar assinatura.');
  }
}

module.exports = { requireActiveSubscription };
