// ===========================
//  Inicialização e imports
// ===========================
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const supabaseDb = require('./supabase/supabaseDb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===========================
//  Webhook do Mercado Pago
// ===========================
// ⚠️ Este middleware deve vir ANTES do bodyParser.
// Garante que o corpo do webhook chegue cru (Buffer),
// para validações e parsing corretos no controller.
app.use('/api/checkout/webhook', express.raw({ type: '*/*' }));

// ===========================
//  Middlewares globais
// ===========================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Sessão compartilhada com o Socket.io
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 dia
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// Usuário disponível globalmente nas views EJS
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  next();
});

// ===========================
//  EJS e arquivos estáticos
// ===========================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ===========================
//  Rotas principais
// ===========================
app.use('/', require('./routes/index'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/produtos'));
app.use('/', require('./routes/perfil'));
app.use('/', require('./routes/loja'));
app.use('/', require('./routes/carrinho'));
app.use('/', require('./routes/pedidos'));
app.use('/', require('./routes/chat'));
app.use('/', require('./routes/modelos')); 
app.use('/', require('./routes/descricao')); 
app.use('/', require('./routes/avaliacoes'));
app.use('/', require('./routes/financeiro'));
app.use('/', require('./routes/ofertas'));

// ===========================
//  Rotas do Mercado Pago
// ===========================
//  Inclui: /create-preference, /webhook, /sucesso, /pendente, /erro
app.use('/api/checkout', require('./routes/mercadopago'));

// ===========================
//  Socket.io
// ===========================
io.on('connection', (socket) => {
  const usuarioAtual = socket.request?.session?.usuario?.id;

  if (!usuarioAtual) {
    console.log('Socket sem sessão válida — desconectando.');
    socket.disconnect(true);
    return;
  }

  console.log(`Socket conectado: user=${usuarioAtual}`);

  socket.on('joinRoom', (chatId) => {
    if (!chatId) return;
    socket.join(chatId);
  });

  socket.on('send_message', async ({ chatId, mensagem }) => {
    try {
      if (!chatId || !mensagem || !mensagem.trim()) return;

      const { data, error } = await supabaseDb
        .from('mensagens')
        .insert([{
          chat_id: chatId,
          id_remetente: usuarioAtual,
          mensagem: mensagem.trim()
        }])
        .select()
        .single();

      if (error) {
        console.error('Erro ao salvar mensagem no Supabase:', error);
        return;
      }

      io.to(chatId).emit('mensagemRecebida', data);
    } catch (err) {
      console.error('Erro inesperado ao salvar/enviar mensagem:', err);
    }
  });

  socket.on('disconnect', () => {
    // console.log(`Socket user=${usuarioAtual} desconectou`);
  });
});

// ===========================
//  Inicializa o servidor
// ===========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});
