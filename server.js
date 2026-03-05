const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Estado do cronômetro
let timerState = {
  status: 'stopped',   // 'stopped' | 'running' | 'paused'
  startTime: null,     // timestamp Unix de quando iniciou (ms)
  elapsed: 0,          // ms acumulados antes do último pause
};

// Senha do admin (troque se quiser)
const ADMIN_PASSWORD = 'admin123';

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  // Envia o estado atual para quem acabou de conectar
  socket.emit('timer:state', timerState);

  // Login admin
  socket.on('admin:login', (password, callback) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admins');
      callback({ success: true });
    } else {
      callback({ success: false });
    }
  });

  // START
  socket.on('timer:start', () => {
    if (!socket.rooms.has('admins')) return;
    if (timerState.status === 'running') return;

    timerState.startTime = Date.now();
    timerState.status = 'running';
    io.emit('timer:state', timerState);
  });

  // PAUSE
  socket.on('timer:pause', () => {
    if (!socket.rooms.has('admins')) return;
    if (timerState.status !== 'running') return;

    timerState.elapsed += Date.now() - timerState.startTime;
    timerState.startTime = null;
    timerState.status = 'paused';
    io.emit('timer:state', timerState);
  });

  // RESET
  socket.on('timer:reset', () => {
    if (!socket.rooms.has('admins')) return;

    timerState = { status: 'stopped', startTime: null, elapsed: 0 };
    io.emit('timer:state', timerState);
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
