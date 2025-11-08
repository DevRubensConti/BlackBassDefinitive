const express = require('express');
const router = express.Router();
// const supabase = require('../supabase'); // REMOVED
const supabaseAuth = require('../supabase/supabaseAuth'); // ADDED: ANON (Auth)
const supabaseDb   = require('../supabase/supabaseDb');   // ADDED: SERVICE ROLE (DB)
const bcrypt = require('bcrypt'); // (opcional) remova se não usar
const { ensureLoja, onlyDigits } = require('../helpers/loja');
const redirectUrl = process.env.AUTH_REDIRECT_URL;

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

  // 2) Busca PF (SERVICE ROLE)
  const pfResp = await supabaseDb
    .from('usuarios_pf')
    .select('*')
    .eq('id', uid)
    .maybeSingle();
  const pf = pfResp.data;

  // 3) Se não for PF, tenta PJ (SERVICE ROLE)
  let usuario = pf;
  let tipo = 'pf';

  if (!usuario) {
    const pjResp = await supabaseDb
      .from('usuarios_pj')
      .select('*')
      .eq('id', uid)
      .maybeSingle();
    const pj = pjResp.data;

    if (!pj) {
      return res.status(401).render('login', { erroLogin: 'Usuário não encontrado.', email });
    }
    usuario = pj;
    tipo = 'pj';
  }

  // 4) Regenera a sessão para não herdar dados antigos
  req.session.regenerate(err => {
    if (err) {
      console.error('Erro ao regenerar sessão:', err);
      return res.status(500).send('Erro de sessão.');
    }

    // 5) Seta a sessão limpa (normalizando tipo)
    const iconeValida =
      usuario.icone_url &&
      usuario.icone_url !== 'null' &&
      String(usuario.icone_url).trim() !== '';

    req.session.usuario = {
      id: uid,
      nome: usuario.nome || usuario.nome_fantasia || usuario.nomeFantasia || '',
      tipo: (tipo || '').toLowerCase(), // 'pf' ou 'pj'
      email: usuario.email,
      telefone: usuario.telefone,
      icone_url: iconeValida
        ? usuario.icone_url
        : (tipo === 'pj' ? '/images/store_logos/store.png' : '/images/user_default.png')
    };

    // 6) Garante persistência antes do redirect
    req.session.save(saveErr => {
      if (saveErr) {
        console.error('Erro ao salvar sessão:', saveErr);
        return res.status(500).send('Erro de sessão.');
      }
      res.redirect('/');
    });
  });
});

// (Opcional) Reenviar e-mail de confirmação – usa supabaseAuth
router.post('/auth/reenviar-confirmacao', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.redirect('/login');

  const { error } = await supabaseAuth.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: redirectUrl }
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
// CADASTRO PJ
// ================================
router.post('/cadastro-pj', async (req, res) => {
  const {
    nomeFantasia, razaoSocial, cnpj, email, senha, telefone,
    cep, estado, endereco, numero, bairro, complemento, cidade, descricao
  } = req.body;

  try {
    // 1) e-mail único entre PF e PJ
    const [{ data: ePF }, { data: ePJ }] = await Promise.all([
      supabaseDb.from('usuarios_pf').select('id').eq('email', email).maybeSingle(),
      supabaseDb.from('usuarios_pj').select('id').eq('email', email).maybeSingle()
    ]);
    if (ePF || ePJ) {
      return res.render('cadastro-pj', { mensagemErro: 'Já existe uma conta com esse e-mail.' });
    }

    // 2) CNPJ único
    const cnpjDigits = onlyDigits(cnpj);
    if (cnpjDigits) {
      const { data: cnpjExist } = await supabaseDb
        .from('usuarios_pj')
        .select('id')
        .eq('cnpj', cnpjDigits)
        .maybeSingle();
      if (cnpjExist) {
        return res.render('cadastro-pj', { mensagemErro: 'Já existe uma loja com esse CNPJ.' });
      }
    }

    // 3) Auth signUp (envia e-mail de confirmação)
    const { data: signUp, error: signErr } = await supabaseAuth.auth.signUp({
      email,
      password: senha,
      options: { emailRedirectTo: redirectUrl }
    });
    if (signErr || !signUp?.user) {
      console.error('Auth signUp (PJ) error:', signErr);
      return res.render('cadastro-pj', { mensagemErro: 'Erro ao registrar no sistema de autenticação.' });
    }
    const uid = signUp.user.id;

    // 4) Inserir em usuarios_pj
    const pjRow = {
      id: uid,
      nomeFantasia,
      razaoSocial,
      cnpj: cnpjDigits || null,
      email,
      telefone,
      cep,
      estado,
      endereco,
      numero,
      bairro,
      complemento,
      cidade: cidade || null,
      descricao: descricao || null
    };
    const { error: insertPJError } = await supabaseDb.from('usuarios_pj').insert([pjRow]);
    if (insertPJError) {
      console.error('Insert usuarios_pj error:', insertPJError);
      return res.status(500).render('cadastro-pj', { mensagemErro: 'Erro ao cadastrar loja (dados PJ).' });
    }

    // 5) Loja 1:1 (com cidade e icone_url)
    await ensureLoja({
      usuarioId: uid,
      tipo: 'PJ',
      nomeFantasia: nomeFantasia || razaoSocial,
      cnpj: cnpjDigits || null,
      cidade: cidade || null,
      estado: estado || null,
      descricao: descricao || null
    });

    // 6) Redireciona para aviso de confirmação
    return res.redirect(`/verifique-email?email=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('Erro no cadastro PJ:', err);
    return res.status(500).render('cadastro-pj', { mensagemErro: err.message || 'Erro interno ao processar cadastro' });
  }
});

// ================================
// CADASTRO PF
// ================================
router.post('/cadastro-pf', async (req, res) => {
  try {
    const {
      nome, sobrenome, cpf, data_nascimento,
      email, senha, telefone,
      cep, estado, cidade, endereco, numero, bairro, complemento
    } = req.body;

    // 1) e-mail único entre PF e PJ
    const [{ data: ePF }, { data: ePJ }] = await Promise.all([
      supabaseDb.from('usuarios_pf').select('id').eq('email', email).maybeSingle(),
      supabaseDb.from('usuarios_pj').select('id').eq('email', email).maybeSingle()
    ]);
    if (ePF || ePJ) {
      return res.render('cadastro-pf', { mensagemErro: 'Já existe uma conta com esse e-mail.' });
    }

    // 2) CPF único
    const cpfDigits = onlyDigits(cpf);
    if (cpfDigits) {
      const { data: cpfExist } = await supabaseDb
        .from('usuarios_pf')
        .select('id')
        .eq('cpf', cpfDigits)
        .maybeSingle();
      if (cpfExist) {
        return res.render('cadastro-pf', { mensagemErro: 'Já existe uma conta com esse CPF.' });
      }
    }

    // 3) Auth signUp (e-mail de confirmação)
    const { data: signUp, error: signErr } = await supabaseAuth.auth.signUp({
      email,
      password: senha,
      options: { emailRedirectTo: redirectUrl }
    });
    if (signErr || !signUp?.user) {
      console.error('Auth signUp (PF) error:', signErr);
      return res.render('cadastro-pf', { mensagemErro: 'Erro ao registrar no sistema de autenticação.' });
    }
    const uid = signUp.user.id;

    // 4) Inserir em usuarios_pf
    const pfRow = {
      id: uid,
      nome,
      sobrenome,
      cpf: cpfDigits || null,
      data_nascimento: data_nascimento || null,
      email,
      telefone,
      cep,
      estado,
      cidade: cidade || null,
      endereco,
      numero,
      bairro,
      complemento
    };
    const { error: dbError } = await supabaseDb.from('usuarios_pf').insert([pfRow]);
    if (dbError) {
      console.error('Insert usuarios_pf error:', dbError);
      return res.status(500).render('cadastro-pf', { mensagemErro: 'Erro ao salvar os dados do usuário (PF).' });
    }

    // 5) Loja 1:1 (PF também ganha cidade e ícone)
    await ensureLoja({
      usuarioId: uid,
      tipo: 'PF',
      nomeFantasia: `${nome || ''} ${sobrenome || ''}`.trim(),
      cpf: cpfDigits || null,
      cidade: cidade || null,
      estado: estado || null
    });

    // 6) Aviso para verificar o e-mail
    return res.redirect(`/verifique-email?email=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('Erro no cadastro PF:', err);
    return res.status(500).render('cadastro-pf', { mensagemErro: err.message || 'Erro interno ao processar cadastro' });
  }
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

router.get('/cadastro-pf', (req, res) => {
  res.render('cadastro-pf', { mensagemErro: null });
});

router.get('/cadastro-pj', (req, res) => {
  res.render('cadastro-pj', { mensagemErro: null });
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
      redirectTo: `${String(redirectUrl || '').replace(/\/$/, '')}/auth/reset`
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
