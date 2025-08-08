const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 60000 });

// Room structure
// rooms = Map(roomId => { chess, players: { socketId: { id, name, color }}, order: [socketId], timers: {white: secs, black: secs}, timerRunning: false, timerInterval: null })
const rooms = new Map();

function makeRoom(roomId, initialSeconds){
  const chess = new Chess();
  return { chess, players: {}, order: [], timers: { white: initialSeconds, black: initialSeconds }, timerRunning: false, turnStartTs: null };
}

io.on('connection', (socket) => {
  console.log('conn', socket.id);

  socket.on('join', ({ roomId, name, desiredTime }) => {
    if (!roomId) return socket.emit('error', 'room required');
    let r = rooms.get(roomId);
    if (!r) {
      const secs = Number(desiredTime) || 300; // default 5 min
      r = makeRoom(roomId, secs);
      rooms.set(roomId, r);
    }

    if (Object.keys(r.players).length >= 2) return socket.emit('error', 'room full');

    // assign color
    const color = Object.keys(r.players).length === 0 ? 'white' : 'black';
    r.players[socket.id] = { id: socket.id, name: name || 'Guest', color };
    r.order.push(socket.id);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.color = color;

    // send joined + current state
    socket.emit('joined', { color, fen: r.chess.fen(), timers: r.timers, names: r.order.map(id => r.players[id].name) });

    // if two players, start game and (if not already) start timer loop
    if (Object.keys(r.players).length === 2) {
      io.to(roomId).emit('start', { fen: r.chess.fen(), timers: r.timers, turn: r.chess.turn() === 'w' ? 'white' : 'black', names: r.order.map(id => r.players[id].name) });
      startTimers(roomId);
    } else {
      socket.emit('waiting', 'Waiting for opponent');
    }

    // inform others
    socket.to(roomId).emit('player-joined', { name: r.players[socket.id].name, color });
  });

  socket.on('move', ({ from, to, promotion }) => {
    const roomId = socket.roomId; if (!roomId) return;
    const r = rooms.get(roomId); if (!r) return;
    const player = r.players[socket.id]; if (!player) return socket.emit('error', 'player not found');

    // forbid move if not player's turn
    const expected = r.chess.turn() === 'w' ? 'white' : 'black';
    if (player.color !== expected) return socket.emit('invalid', 'not your turn');

    const move = r.chess.move({ from, to, promotion: promotion || 'q' });
    if (!move) return socket.emit('invalid', 'illegal move');

    // update timers: deduct elapsed since turnStartTs
    stopTurnTimerUpdate(roomId);

    io.to(roomId).emit('move', { move, fen: r.chess.fen(), pgn: r.chess.pgn(), turn: r.chess.turn() === 'w' ? 'white' : 'black', timers: r.timers });

    // if game over
    if (r.chess.game_over()) {
      io.to(roomId).emit('gameover', { reason: r.chess.in_checkmate() ? 'checkmate' : 'draw', pgn: r.chess.pgn(), fen: r.chess.fen() });
      // cleanup after delay
      setTimeout(() => { rooms.delete(roomId); }, 1000 * 60 * 5);
      return;
    }

    // start next player's timer
    startTimers(roomId);
  });

  socket.on('chat', ({ text }) => {
    const roomId = socket.roomId; if (!roomId) return;
    const r = rooms.get(roomId); if (!r) return;
    const sender = r.players[socket.id] && r.players[socket.id].name || 'Guest';
    const msg = { sender, text, ts: Date.now() };
    io.to(roomId).emit('chat', msg);
  });

  socket.on('resign', () => {
    const roomId = socket.roomId; if (!roomId) return;
    const r = rooms.get(roomId); if (!r) return;
    const loser = r.players[socket.id]; if (!loser) return;
    const winnerColor = loser.color === 'white' ? 'black' : 'white';
    io.to(roomId).emit('resign', { winner: winnerColor });
    clearRoom(roomId);
  });

  socket.on('offer_draw', () => {
    const roomId = socket.roomId; if (!roomId) return;
    socket.to(roomId).emit('offer_draw', { from: rplayersafeName(roomId, socket.id) });
  });

  socket.on('accept_draw', () => {
    const roomId = socket.roomId; if (!roomId) return;
    io.to(roomId).emit('draw', { message: 'Draw accepted' });
    clearRoom(roomId);
  });

  socket.on('rematch', () => {
    const roomId = socket.roomId; if (!roomId) return;
    const r = rooms.get(roomId); if (!r) return;
    r.chess = new Chess();
    r.timers = r.timers; // keep same timers
    io.to(roomId).emit('rematch', { fen: r.chess.fen(), timers: r.timers });
    startTimers(roomId);
  });

  socket.on('disconnect', (reason) => {
    const roomId = socket.roomId; if (!roomId) return;
    const r = rooms.get(roomId); if (!r) return;
    // remove player
    delete r.players[socket.id];
    r.order = r.order.filter(id => id !== socket.id);
    socket.to(roomId).emit('peer-left');
    // stop timers if no players
    if (Object.keys(r.players).length === 0) clearRoom(roomId);
  });
});

function rplayersafeName(roomId, socketId){
  const r = rooms.get(roomId); if (!r) return 'Guest';
  return (r.players[socketId] && r.players[socketId].name) || 'Guest';
}

function clearRoom(roomId){
  const r = rooms.get(roomId); if (!r) return;
  rooms.delete(roomId);
}

function startTimers(roomId){
  const r = rooms.get(roomId); if (!r) return;
  // set turn start timestamp
  r.turnStartTs = Date.now();
  if (r.timerRunning) return; // already running
  r.timerRunning = true;

  // single interval for turn updates
  r.timerInterval = setInterval(() => {
    const currentTurn = r.chess.turn() === 'w' ? 'white' : 'black';
    const elapsed = Math.floor((Date.now() - r.turnStartTs) / 1000);
    // Compute decreased time for currentTurn
    r.timers[currentTurn] = Math.max(0, r.timers[currentTurn] - elapsed);
    r.turnStartTs = Date.now();

    io.to(roomId).emit('timers', { timers: r.timers, turn: currentTurn });

    if (r.timers[currentTurn] <= 0) {
      // time over -> opponent wins
      const winner = currentTurn === 'white' ? 'black' : 'white';
      io.to(roomId).emit('timeouts', { winner });
      clearInterval(r.timerInterval);
      clearRoom(roomId);
    }
  }, 1000);
}

function stopTurnTimerUpdate(roomId){
  const r = rooms.get(roomId); if (!r) return;
  if (!r.timerInterval) return;
  clearInterval(r.timerInterval);
  r.timerInterval = null;
  r.timerRunning = false;
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Server running on', PORT));