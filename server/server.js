// server/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 60000
});

// rooms Map: roomId -> roomObj
// roomObj = {
//   chess: Chess instance,
//   players: { playerId: { playerId, socketId, name, color, connected } },
//   order: [playerId,playerId],
//   timers: { white: secs, black: secs },
//   timerInterval: NodeTimer or null,
//   turnStartTs: ms timestamp
// }
const rooms = new Map();

function makeRoom(initialSeconds = 300) {
  return {
    chess: new Chess(),
    players: {},
    order: [],
    timers: { white: initialSeconds, black: initialSeconds },
    timerInterval: null,
    turnStartTs: null
  };
}

function getPlayerBySocket(room, socketId) {
  return Object.values(room.players).find(p => p.socketId === socketId) || null;
}

function safeEmitToRoom(roomId, event, payload) {
  io.to(roomId).emit(event, payload);
}

function startTimerLoop(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  // already running?
  if (room.timerInterval) return;
  room.turnStartTs = Date.now();

  room.timerInterval = setInterval(() => {
    // compute elapsed since last tick and decrement current player's timer by 1 every second
    const currentTurn = room.chess.turn() === 'w' ? 'white' : 'black';
    // decrement by 1 second
    if (room.timers[currentTurn] > 0) {
      room.timers[currentTurn] = Math.max(0, room.timers[currentTurn] - 1);
    }
    safeEmitToRoom(roomId, 'timers', { timers: room.timers, turn: currentTurn });

    if (room.timers[currentTurn] <= 0) {
      // time over -> opponent wins
      const winner = currentTurn === 'white' ? 'black' : 'white';
      safeEmitToRoom(roomId, 'timeouts', { winner });
      clearRoom(roomId);
    }
  }, 1000);
}

function stopTimerLoop(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  room.turnStartTs = null;
}

function clearRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  stopTimerLoop(roomId);
  rooms.delete(roomId);
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // Join or rejoin a room.
  // payload: { roomId, name, desiredTime (secs), playerId? }
  socket.on('join', (payload = {}) => {
    try {
      const { roomId, name, desiredTime, playerId: incomingPid } = payload;
      if (!roomId) return socket.emit('error', 'roomId required');

      let room = rooms.get(roomId);
      if (!room) {
        const secs = Number(desiredTime) || 300;
        room = makeRoom(secs);
        rooms.set(roomId, room);
      }

      // If client provided playerId and it exists in room, treat as reconnect
      let pid = incomingPid;
      let playerObj = pid ? room.players[pid] : null;

      if (playerObj && !playerObj.connected) {
        // Reattach socket
        playerObj.socketId = socket.id;
        playerObj.connected = true;
        socket.join(roomId);
        socket.roomId = roomId;
        socket.playerId = pid;
        socket.color = playerObj.color;

        // send state to rejoined player
        socket.emit('joined', { playerId: pid, color: playerObj.color, fen: room.chess.fen(), timers: room.timers, names: room.order.map(id => room.players[id].name) });
        safeEmitToRoom(roomId, 'player-reconnected', { playerId: pid, name: playerObj.name, color: playerObj.color });
        return;
      }

      // New join (not reconnect)
      if (Object.keys(room.players).length >= 2) {
        return socket.emit('error', 'room full');
      }

      // Create new playerId
      pid = uuidv4();
      const color = Object.keys(room.players).length === 0 ? 'white' : 'black';
      const playerName = name || 'Guest';

      room.players[pid] = {
        playerId: pid,
        socketId: socket.id,
        name: playerName,
        color,
        connected: true
      };
      room.order.push(pid);

      socket.join(roomId);
      socket.roomId = roomId;
      socket.playerId = pid;
      socket.color = color;

      // send joined event including playerId (client should store this)
      socket.emit('joined', { playerId: pid, color, fen: room.chess.fen(), timers: room.timers, names: room.order.map(id => room.players[id].name) });

      // If two players, start the game (or resume) and start timers
      if (Object.keys(room.players).length === 2) {
        safeEmitToRoom(roomId, 'start', { fen: room.chess.fen(), timers: room.timers, turn: room.chess.turn() === 'w' ? 'white' : 'black', names: room.order.map(id => room.players[id].name) });
        // Ensure timers are running
        startTimerLoop(roomId);
      } else {
        socket.emit('waiting', 'Waiting for opponent...');
      }

      // notify others
      socket.to(roomId).emit('player-joined', { playerId: pid, name: playerName, color });

    } catch (err) {
      console.error('join error', err);
      socket.emit('error', 'join failed');
    }
  });

  // Move: payload { from, to, promotion? }
  socket.on('move', (payload = {}) => {
    try {
      const roomId = socket.roomId;
      if (!roomId) return socket.emit('error', 'not in room');
      const room = rooms.get(roomId);
      if (!room) return socket.emit('error', 'room not found');

      const player = room.players[socket.playerId];
      if (!player) return socket.emit('error', 'player not found');

      // ensure correct turn
      const expected = room.chess.turn() === 'w' ? 'white' : 'black';
      if (player.color !== expected) return socket.emit('invalid', 'not your turn');

      // before applying move, deduct elapsed seconds since last turnStartTs to the current player's timer
      if (room.turnStartTs) {
        const elapsedMs = Date.now() - room.turnStartTs;
        const elapsedSec = Math.floor(elapsedMs / 1000);
        // Deduct elapsed from the player who started that turn (i.e., expected before move was this player's color)
        const currentTurnBeforeMove = expected; // this was the moving player's color
        room.timers[currentTurnBeforeMove] = Math.max(0, room.timers[currentTurnBeforeMove] - elapsedSec);
      }

      // apply move
      const move = room.chess.move({ from: payload.from, to: payload.to, promotion: payload.promotion || 'q' });
      if (!move) {
        // invalid move - do not crash server
        return socket.emit('invalid', 'illegal move');
      }

      // update fen/pgn
      const fen = room.chess.fen();
      const pgn = room.chess.pgn();

      // reset turnStartTs and restart timer loop for next player
      room.turnStartTs = Date.now();
      // stop and restart to resync exact per-second interval
      stopTimerLoop(roomId);
      startTimerLoop(roomId);

      // broadcast move to everyone in room
      safeEmitToRoom(roomId, 'move', { move, fen, pgn, turn: room.chess.turn() === 'w' ? 'white' : 'black', timers: room.timers });

      // check game over
      if (room.chess.game_over()) {
        safeEmitToRoom(roomId, 'gameover', { reason: room.chess.in_checkmate() ? 'checkmate' : 'draw', pgn, fen });
        // clear room after short delay
        setTimeout(() => clearRoom(roomId), 1000 * 30);
      }

    } catch (err) {
      console.error('move error', err);
      socket.emit('error', 'move failed');
    }
  });

  socket.on('chat', ({ text } = {}) => {
    try {
      const roomId = socket.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const sender = (room.players[socket.playerId] && room.players[socket.playerId].name) || 'Guest';
      const msg = { sender, text: String(text || '').slice(0, 400), ts: Date.now() };
      safeEmitToRoom(roomId, 'chat', msg);
    } catch (err) { console.error('chat error', err); }
  });

  socket.on('resign', () => {
    try {
      const roomId = socket.roomId; if (!roomId) return;
      const room = rooms.get(roomId); if (!room) return;
      const loser = room.players[socket.playerId]; if (!loser) return;
      const winnerColor = loser.color === 'white' ? 'black' : 'white';
      safeEmitToRoom(roomId, 'resign', { winner: winnerColor });
      clearRoom(roomId);
    } catch (err) { console.error('resign error', err); }
  });

  socket.on('rematch', () => {
    try {
      const roomId = socket.roomId; if (!roomId) return;
      const room = rooms.get(roomId); if (!room) return;
      room.chess = new Chess();
      room.turnStartTs = Date.now();
      room.timers = room.timers; // keep same times
      safeEmitToRoom(roomId, 'rematch', { fen: room.chess.fen(), timers: room.timers });
      stopTimerLoop(roomId);
      startTimerLoop(roomId);
    } catch (err) { console.error('rematch error', err); }
  });

  socket.on('disconnect', (reason) => {
    try {
      const roomId = socket.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const player = getPlayerBySocket(room, socket.id);
      if (!player) return;

      // mark disconnected, keep their player object so they can reconnect later
      player.connected = false;
      player.socketId = null;
      socket.to(roomId).emit('peer-left', { playerId: player.playerId, name: player.name, color: player.color });

      // if both players gone, clear room
      const connectedCount = Object.values(room.players).filter(p => p.connected).length;
      if (connectedCount === 0) {
        clearRoom(roomId);
      }
    } catch (err) {
      console.error('disconnect handling error', err);
    }
  });

}); // end io.on connection

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Server listening on', PORT));
