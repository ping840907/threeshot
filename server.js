import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const players = {};
const colors = ['#ff5722', '#e91e63', '#9c27b0', '#00abc5', '#4caf50', '#ffeb3b'];

io.on('connection', (socket) => {
  console.log(`玩家連線: ${socket.id}`);

  players[socket.id] = {
    id: socket.id,
    position: { x: 0, y: 1.6, z: 5 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    color: colors[Math.floor(Math.random() * colors.length)]
  };

  socket.emit('current_players', players);
  socket.broadcast.emit('player_joined', players[socket.id]);

  socket.on('update_transform', (data) => {
    if (players[socket.id]) {
      players[socket.id].position = data.position;
      players[socket.id].rotation = data.rotation;
      socket.broadcast.emit('player_updated', players[socket.id]);
    }
  });

  socket.on('fire', (fireData) => {
    socket.broadcast.emit('player_fired', {
      playerId: socket.id,
      startPos: fireData.startPos,
      launchDir: fireData.launchDir,
      speed: fireData.speed
    });
  });

  socket.on('disconnect', () => {
    console.log(`玩家離線: ${socket.id}`);
    delete players[socket.id];
    io.emit('player_left', socket.id);
  });
});

server.listen(3000, () => console.log('Game Server running on port 3000'));

