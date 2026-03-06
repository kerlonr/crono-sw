const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = 'admin123';

let status = 'stopped';
let elapsed = 0;
let startTime = null;
let interval = null;

function getElapsed() {
  if (status === 'running') return elapsed + (Date.now() - startTime);
  return elapsed;
}

function broadcast() {
  io.emit('timer:tick', { status, elapsed: getElapsed() });
}

function startBroadcast() {
  if (interval) return;
  interval = setInterval(broadcast, 100);
}

function stopBroadcast() {
  clearInterval(interval);
  interval = null;
}

io.on('connection', (socket) => {
  socket.emit('timer:tick', { status, elapsed: getElapsed() });

  socket.on('admin:login', (password, callback) => {
    if (password === ADMIN_PASSWORD) {
      socket.join('admins');
      callback({ success: true });
    } else {
      callback({ success: false });
    }
  });

  socket.on('timer:start', () => {
    if (!socket.rooms.has('admins')) return;
    if (status === 'running') return;
    startTime = Date.now();
    status = 'running';
    startBroadcast();
  });

  socket.on('timer:pause', () => {
    if (!socket.rooms.has('admins')) return;
    if (status !== 'running') return;
    elapsed += Date.now() - startTime;
    startTime = null;
    status = 'paused';
    stopBroadcast();
    broadcast();
  });

  socket.on('timer:reset', () => {
    if (!socket.rooms.has('admins')) return;
    elapsed = 0;
    startTime = null;
    status = 'stopped';
    stopBroadcast();
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
