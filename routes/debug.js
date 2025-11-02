// routes/debug.js
const express = require('express');
const router = express.Router();

router.get('/debug-key-role', (req, res) => {
  try {
    const token = process.env.SUPABASE_SERVICE_ROLE_KEY; // mesma env do seu supabase/index.js
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return res.json({ role: payload.role }); // precisa ser "service_role"
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao decodificar chave', message: e.message });
  }
});

const supabaseDb = require('../supabase/supabaseDb');

router.post('/debug-create-user', async (req, res) => {
  try {
    const email = `teste_${Date.now()}@exemplo.com`;
    const password = 'SenhaForte123!';
    const { data, error } = await supabaseDb.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, userId: data.user.id, email });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});


module.exports = router;
