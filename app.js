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

// ---------- Middlewares globais ----------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// usamos UMA instância de session p/ compartilhar com o Socket.io
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 dia
});
app.use(sessionMiddleware);

// Compartilha a sessão do Express com o Socket.io
io.engine.use(sessionMiddleware);

// Deixa o usuário disponível em todas as views
app.use((req, res, next) => {
  res.locals.usuario = req.session.usuario || null;
  next();
});

// ---------- EJS e estáticos ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Rotas ----------
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



// ---------- Socket.io ----------
io.on('connection', (socket) => {
  const usuarioAtual = socket.request?.session?.usuario?.id;

  if (!usuarioAtual) {
    // sem sessão válida? não deixa enviar/entrar em salas
    console.log('Socket sem sessão válida — desconectando.');
    socket.disconnect(true);
    return;
  }

  console.log(`Socket conectado: user=${usuarioAtual}`);

  // Entrar na sala do CHAT (usa o chat_id como nome da sala)
  socket.on('joinRoom', (chatId) => {
    if (!chatId) return;
    socket.join(chatId);
    // opcional: console.log(`user=${usuarioAtual} entrou na sala ${chatId}`);
  });

  // Enviar mensagem (tempo real + persistência)
  socket.on('send_message', async ({ chatId, mensagem }) => {
    try {
      if (!chatId || !mensagem || !mensagem.trim()) return;

      // Salva no Supabase conforme nova estrutura
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

      // Emite para todos da sala (incluindo quem enviou)
      io.to(chatId).emit('mensagemRecebida', data);
    } catch (err) {
      console.error('Erro inesperado ao salvar/enviar mensagem:', err);
    }
  });

  socket.on('disconnect', () => {
    // opcional: console.log(`Socket user=${usuarioAtual} desconectou`);
  });
});

// ---------- Inicializa o servidor ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
