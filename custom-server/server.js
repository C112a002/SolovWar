const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});
const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = Math.max(2, Math.min(64, Number(process.env.MAX_PLAYERS || 16)));
const rooms = new Map();
const playerRooms = new Map();

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/', (_req, res) => res.type('text').send('SolovWar custom Socket.IO server is running.'));

function code() {
  let value;
  do value = crypto.randomBytes(4).toString('hex').toUpperCase(); while (rooms.has(value));
  return value;
}
function passwordHash(password) { return password ? crypto.createHash('sha256').update(String(password)).digest('hex') : ''; }
function snapshot(room) {
  return { code: room.code, name: room.name, maxPlayers: room.maxPlayers, hostId: room.hostId, players: [...room.players.values()] };
}
function leaveRoom(socket) {
  const roomId = playerRooms.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  playerRooms.delete(socket.id);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(roomId);
  if (!room.players.size) { rooms.delete(roomId); return; }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  io.to(roomId).emit('room:state', snapshot(room));
}
function joinResult(socket, room, name) {
  const player = { id: socket.id, name: String(name || '特戰員').slice(0, 18), position: { x: 0, y: 1.7, z: 0 }, rotation: { x: 0, y: 0 }, health: 100 };
  room.players.set(socket.id, player); playerRooms.set(socket.id, room.code); socket.join(room.code);
  return { ok: true, playerId: socket.id, server: snapshot(room) };
}

io.on('connection', (socket) => {
  socket.on('room:create', (data = {}, reply = () => {}) => {
    if (playerRooms.has(socket.id)) leaveRoom(socket);
    const room = { code: code(), name: String(data.roomName || 'SolovWar 自訂房間').slice(0, 32), password: passwordHash(data.password), maxPlayers: MAX_PLAYERS, hostId: socket.id, players: new Map() };
    rooms.set(room.code, room); reply(joinResult(socket, room, data.name)); io.to(room.code).emit('room:state', snapshot(room));
  });
  socket.on('room:join', (data = {}, reply = () => {}) => {
    const room = rooms.get(String(data.roomId || '').trim().toUpperCase());
    if (!room) return reply({ ok: false, error: 'ROOM_NOT_FOUND' });
    if (room.players.size >= room.maxPlayers) return reply({ ok: false, error: 'ROOM_FULL' });
    if (room.password !== passwordHash(data.password)) return reply({ ok: false, error: 'INVALID_PASSWORD' });
    if (playerRooms.has(socket.id)) leaveRoom(socket);
    reply(joinResult(socket, room, data.name)); io.to(room.code).emit('room:state', snapshot(room));
  });
  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('player:state', (state = {}) => {
    const room = rooms.get(playerRooms.get(socket.id)); const player = room?.players.get(socket.id); if (!player) return;
    if (state.position) player.position = { x: Number(state.position.x) || 0, y: Number(state.position.y) || 0, z: Number(state.position.z) || 0 };
    if (state.rotation) player.rotation = { x: Number(state.rotation.x) || 0, y: Number(state.rotation.y) || 0 };
    if (Number.isFinite(state.health)) player.health = Math.max(0, Math.min(100, Number(state.health)));
    socket.to(room.code).emit('player:state', player);
  });
  socket.on('combat:shot', (event = {}) => { const room = rooms.get(playerRooms.get(socket.id)); if (room) socket.to(room.code).emit('combat:shot', { playerId: socket.id, weapon: String(event.weapon || '').slice(0, 24) }); });
  socket.on('disconnect', () => leaveRoom(socket));
});

httpServer.listen(PORT, '0.0.0.0', () => console.log(`SolovWar custom server listening on :${PORT}`));
