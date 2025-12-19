const express = require('express');
const router = express.Router();
// const supabase = require('../supabase'); // REMOVED
const supabaseAuth = require('../supabase/supabaseAuth'); // ANON (Auth)
const supabaseDb   = require('../supabase/supabaseDb');   // SERVICE ROLE (DB)
const bcrypt = require('bcrypt'); // (opcional) remova se não usar
const { ensureLoja, onlyDigits } = require('../helpers/loja');

// ================================
// URLS DE REDIRECT (CONFIRMAÇÃO x RECUPERAÇÃO)
// ================================
const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, ''); // ex.: https://blackbass.example.com
const confirmPath = process.env.AUTH_REDIRECT_URL_CONFIRM || '/email-confirmado';
const recoveryPath = process.env.AUTH_REDIRECT_URL_RECOVERY || '/auth/reset';

const CONFIRM_URL = `${baseUrl}${confirmPath}`;
const RECOVERY_URL = `${baseUrl}${recoveryPath}`;

// ================================
// LOGIN
// ================================
router.get('/login', (req, res) => {
  res.render('login');
});

router.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  const { data: loginData, error: loginError } = await supabaseAuth.auth.signInWithPassword({
    email,
    password: senha
  });

  if (loginError || !loginData?.user) {
    console.error('Erro ao logar no Supabase Auth:', loginError);

    // ⚠️ E-mail ainda não confirmado
    if (loginError?.code === 'email_not_confirmed' || /email not confirmed/i.test(loginError?.message || '')) {
      return res.status(401).render('login', {
        erroLogin: 'Seu e-mail ainda não foi confirmado.',
        precisaConfirmar: true,
        email
      });
    }

    // Credenciais inválidas / senha errada
    if (loginError?.code === 'invalid_credentials' || loginError?.status === 400) {
      return res.status(401).render('login', {
        erroLogin: 'E-mail ou senha inválidos.',
        email
      });
    }

    // Genérico
    return res.status(500).render('login', {
      erroLogin: 'Não foi possível fazer login agora. Tente novamente.',
      email
    });
  }

    const uid = loginData.user.id;

  // Busca PF
  const pfResp = await supabaseDb
    .from('usuarios_pf')
    .select('*')
    .eq('id', uid)
    .maybeSingle();
  const pf = pfResp.data;

  // Busca PJ (opcional)
  const pjResp = await supabaseDb
    .from('usuarios_pj')
    .select('*')
    .eq('id', uid)
    .maybeSingle();
  const pj = pjResp.data;

  // Busca loja (prioridade)
  const lojaResp = await supabaseDb
    .from('lojas')
    .select('id, nome_fantasia, icone_url, cidade, estado, cnpj, cpf, tipo')
    .eq('usuario_id', uid)
    .maybeSingle();
  const loja = lojaResp.data;

  const temLoja = !!loja || !!pj;
  const usuarioBase = pf || pj;

  if (!usuarioBase) {
    return res.status(401).render('login', { erroLogin: 'Usuário não encontrado.', email });
  }

  const tipo = temLoja ? 'pj' : 'pf';
  const nomeSessao = temLoja
    ? (loja?.nome_fantasia || pj?.nomeFantasia || pj?.razaoSocial || usuarioBase.nome || '')
    : (`${pf?.nome || ''} ${pf?.sobrenome || ''}`.trim());

  const iconeValida =
    (loja?.icone_url || usuarioBase.icone_url) &&
    (loja?.icone_url || usuarioBase.icone_url) !== 'null' &&
    String(loja?.icone_url || usuarioBase.icone_url).trim() !== '';

  // mantém sua regeneração de sessão aqui:
  req.session.regenerate(err => {
    if (err) {
      console.error('Erro ao regenerar sessão:', err);
      return res.status(500).send('Erro de sessão.');
    }

    req.session.usuario = {
      id: uid,
      nome: nomeSessao,
      tipo,
      email: usuarioBase.email,
      telefone: usuarioBase.telefone,
      icone_url: iconeValida
        ? (loja?.icone_url || usuarioBase.icone_url)
        : (tipo === 'pj' ? '/images/store_logos/store.png' : '/images/user_default.png')
    };

    req.session.save(saveErr => {
      if (saveErr) {
        console.error('Erro ao salvar sessão:', saveErr);
        return res.status(500).send('Erro de sessão.');
      }
      res.redirect('/');
    });
  });

});

// ================================
// CADASTRO ÚNICO (PF + opcional loja)
// ================================
router.get('/cadastro', (req, res) => {
  return res.render('cadastro', { mensagemErro: null });
});

router.post('/cadastro', async (req, res) => {
  try {
    const {
      // pessoais (sempre)
      nome,
      sobrenome,
      cpf,
      data_nascimento,

      // conta
      email,
      senha,
      telefone,

      // endereço
      cep,
      estado,
      cidade,
      endereco,
      numero,
      bairro,
      complemento,

      // switch
      tenho_loja,

      // loja (se tenho_loja)
      nomeFantasia,
      razaoSocial,
      cnpj,
      descricao
    } = req.body;

    const temLoja =
      String(tenho_loja) === 'on' ||
      String(tenho_loja) === 'true' ||
      String(tenho_loja) === '1';

    // -------- validações básicas --------
    if (!nome || !sobrenome || !cpf || !data_nascimento || !email || !senha || !telefone) {
      return res.status(400).render('cadastro', { mensagemErro: 'Preencha todos os campos obrigatórios.' });
    }
    if (!cep || !estado || !cidade || !endereco || !numero || !bairro) {
      return res.status(400).render('cadastro', { mensagemErro: 'Preencha o endereço completo.' });
    }

    const cpfDigits = onlyDigits(cpf);
    const cnpjDigits = onlyDigits(cnpj || '');


    if (!cpfDigits || cpfDigits.length !== 11) {
      return res.status(400).render('cadastro', { mensagemErro: 'CPF inválido.' });
    }

    if (temLoja) {
      if (!nomeFantasia || !razaoSocial || !cnpjDigits || cnpjDigits.length !== 14) {
        return res.status(400).render('cadastro', { mensagemErro: 'Preencha corretamente os dados da loja (Nome Fantasia, Razão Social e CNPJ válido).' });
      }
    }

    // -------- checagens de duplicidade --------
    // E-mail único entre PF e PJ
    const [{ data: ePF }, { data: ePJ }] = await Promise.all([
      supabaseDb.from('usuarios_pf').select('id').eq('email', email).maybeSingle(),
      supabaseDb.from('usuarios_pj').select('id').eq('email', email).maybeSingle()
    ]);
    if (ePF || ePJ) {
      return res.status(400).render('cadastro', { mensagemErro: 'Já existe uma conta com esse e-mail.' });
    }

    // CPF único (recomendado conferir em ambas)
    const [{ data: cpfPF }, { data: cpfPJ }] = await Promise.all([
      supabaseDb.from('usuarios_pf').select('id').eq('cpf', cpfDigits).maybeSingle(),
      supabaseDb.from('usuarios_pj').select('id').eq('cpf', cpfDigits).maybeSingle()
    ]);
    if (cpfPF || cpfPJ) {
      return res.status(400).render('cadastro', { mensagemErro: 'Já existe uma conta com esse CPF.' });
    }

    // CNPJ único (se for loja)
    if (temLoja) {
      const { data: cnpjExist } = await supabaseDb
        .from('usuarios_pj')
        .select('id')
        .eq('cnpj', cnpjDigits)
        .maybeSingle();

      if (cnpjExist) {
        return res.status(400).render('cadastro', { mensagemErro: 'Já existe uma loja com esse CNPJ.' });
      }
    }

    // -------- Auth signUp (Supabase Auth) --------
    const { data: signUp, error: signErr } = await supabaseAuth.auth.signUp({
      email,
      password: senha,
      options: { emailRedirectTo: CONFIRM_URL }
    });

    if (signErr || !signUp?.user) {
      console.error('[CADASTRO] signUp error:', signErr);
      return res.status(500).render('cadastro', { mensagemErro: 'Erro ao registrar no sistema de autenticação.' });
    }

    const uid = signUp.user.id;

// -------- Inserir em PF OU PJ (dependendo do switch) --------
if (!temLoja) {
  // ===== PF =====
  const pfRow = {
    id: uid,
    nome,
    sobrenome,
    cpf: cpfDigits,
    data_nascimento,
    email,
    telefone,
    cep,
    estado,
    cidade,
    endereco,
    numero,
    bairro,
    complemento: complemento || null
  };

  const { error: insertPFError } = await supabaseDb.from('usuarios_pf').insert([pfRow]);
  if (insertPFError) {
    console.error('[CADASTRO] Insert usuarios_pf error:', insertPFError);
    return res.status(500).render('cadastro', { mensagemErro: 'Erro ao salvar os dados do usuário (PF).' });
  }

} else {
  // ===== PJ =====
  const pjRow = {
    id: uid,

    // dados pessoais (puxados do cadastro)
    nome,
    sobrenome,
    cpf: cpfDigits,
    data_nascimento,

    // dados da loja
    nomeFantasia,
    razaoSocial,
    cnpj: cnpjDigits,
    descricao: descricao || null,

    // contato/endereço (se sua tabela PJ tiver essas colunas)
    email,
    telefone,
    cep,
    estado,
    cidade,
    endereco,
    numero,
    bairro,
    complemento: complemento || null,

    // legado (se existir na tabela)
    cpf_responsavel: cpfDigits
  };

  const { error: insertPJError } = await supabaseDb.from('usuarios_pj').insert([pjRow]);
  if (insertPJError) {
    console.error('[CADASTRO] Insert usuarios_pj error:', insertPJError);
    return res.status(500).render('cadastro', { mensagemErro: 'Erro ao salvar os dados do usuário (PJ).' });
  }

  // cria/garante registro em "lojas"
  await ensureLoja({
    usuarioId: uid,
    tipo: 'PJ',
    nomeFantasia: nomeFantasia || razaoSocial,
    cnpj: cnpjDigits,
    cpf: cpfDigits,
    cidade: cidade || null,
    estado: estado || null,
    descricao: descricao || null
  });
}

    // -------- redirect --------
    return res.redirect(`/verifique-email?email=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('[CADASTRO] Erro no cadastro:', err);
    return res.status(500).render('cadastro', { mensagemErro: err.message || 'Erro interno ao processar cadastro.' });
  }
});



// (Opcional) Reenviar e-mail de confirmação – usa supabaseAuth
router.post('/auth/reenviar-confirmacao', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.redirect('/login');

  const { error } = await supabaseAuth.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: CONFIRM_URL }
  });

  if (error) {
    console.error('Erro ao reenviar confirmação:', error);
    return res.status(400).render('login', {
      erroLogin: 'Não foi possível reenviar o e-mail de confirmação. Tente novamente mais tarde.',
      email
    });
  }
  return res.redirect(`/verifique-email?email=${encodeURIComponent(email)}`);
});

// ================================
// LOGOUT
// ================================
router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Erro ao fazer logout:', err);
      return res.status(500).send('Erro ao fazer logout.');
    }
    res.clearCookie('connect.sid', { path: '/', httpOnly: true, secure: false });
    res.redirect('/');
  });
});



// ================================
// PÁGINAS DE CADASTRO E CONFIRMAÇÃO
// ================================
router.get('/signup', (req, res) => {
  res.render('signup');
});

router.get('/escolher-cadastro', (req, res) => {
  res.render('escolher-cadastro');
});


// GET para "verifique seu e-mail"
router.get('/verifique-email', (req, res) => {
  const email = req.query.email;
  if (!email) return res.redirect('/signup');
  res.render('verifique-email', { email });
});

// Página de confirmação de e-mail
router.get('/email-confirmado', (req, res) => {
  res.render('email-confirmado', { loginUrl: '/login' });
});

// ================================
// RECUPERAÇÃO DE SENHA (FORGOT / RESET)
// ================================

// Formulário "Esqueci minha senha"
router.get('/auth/forgot', (req, res) => {
  res.render('auth/forgot'); // views/auth/forgot.ejs
});

// Envio do e-mail de recuperação
router.post('/auth/forgot', async (req, res) => {
  const { email } = req.body;
  try {
    // Mensagem neutra sempre (não revelar se e-mail existe)
    await supabaseAuth.auth.resetPasswordForEmail(email, {
      redirectTo: RECOVERY_URL
    });
  } catch (e) {
    console.error('Erro resetPasswordForEmail:', e);
    // não diferenciamos erros para evitar enumeração de e-mails
  }
  return res.redirect('/auth/forgot/done');
});

// Página "verifique seu e-mail"
router.get('/auth/forgot/done', (req, res) => {
  res.render('auth/forgot_done'); // views/auth/forgot_done.ejs
});

// Página de redefinição (front usará supabase-js para trocar a senha)
router.get('/auth/reset', (req, res) => {
  res.render('auth/reset', {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
  });
});

module.exports = router;
