const http = require('http');
const WebSocket = require('ws');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const server = http.createServer();
const wss = new WebSocket.Server({ server, clientTracking: true });

// rooms: roomId -> { players: { [playerId]: { ws, name, color } }, order: [playerId,...], chess: Chess, chat: [], createdAt }
const rooms = new Map();

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) { /* ignore */ }
}

function broadcastRoom(r, obj) {
  Object.values(r.players).forEach(p => safeSend(p.ws, obj));
}

wss.on('connection', (ws, req) => {
  ws.id = uuidv4();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }

    // Join or create room
    if (data.type === 'join') {
      const { room: roomId, name } = data;
      if (!roomId) return safeSend(ws, { type: 'error', message: 'room required' });

      let r = rooms.get(roomId);
      if (!r) {
        r = { players: {}, order: [], chess: new Chess(), chat: [], createdAt: Date.now(), fen: new Chess().fen() };
        rooms.set(roomId, r);
      }

      // If player reconnecting with same id
      const wantName = name || 'Guest';

      // Assign color: first player white, second black
      if (Object.keys(r.players).length < 2) {
        const color = Object.keys(r.players).length === 0 ? 'white' : 'black';
        r.players[ws.id] = { ws, name: wantName, color };
        r.order.push(ws.id);
        ws.room = roomId;
        ws.playerId = ws.id;

        safeSend(ws, { type: 'joined', playerId: ws.id, color, fen: r.chess.fen(), names: r.order.map(id => r.players[id].name) });

        // If both present, start
        if (Object.keys(r.players).length === 2) {
          broadcastRoom(r, { type: 'start', fen: r.chess.fen(), names: r.order.map(id => r.players[id].name), turn: r.chess.turn() === 'w' ? 'white' : 'black' });
        } else {
          safeSend(ws, { type: 'waiting', message: 'Waiting for opponent...' });
        }
      } else {
        // Room full — reject
        return safeSend(ws, { type: 'error', message: 'room full' });
      }
    }

    // Move
    else if (data.type === 'move') {
      const roomId = ws.room;
      if (!roomId) return safeSend(ws, { type: 'error', message: 'not in room' });
      const r = rooms.get(roomId);
      if (!r) return safeSend(ws, { type: 'error', message: 'room not found' });

      const move = data.move; // {from, to, promotion?}
      const chess = r.chess;

      // Validate turn: ensure the player color matches chess.turn()
      const player = r.players[ws.playerId];
      if (!player) return safeSend(ws, { type: 'error', message: 'player not found' });
      const expectedColor = chess.turn() === 'w' ? 'white' : 'black';
      if (player.color !== expectedColor) return safeSend(ws, { type: 'error', message: 'not your turn' });

      const result = chess.move(move);
      if (!result) return safeSend(ws, { type: 'invalid', message: 'illegal move' });

      r.fen = chess.fen();
      r.pgn = chess.pgn();

      broadcastRoom(r, { type: 'move', move: result, fen: r.fen, pgn: r.pgn, turn: chess.turn() === 'w' ? 'white' : 'black' });

      if (chess.game_over()) {
        broadcastRoom(r, { type: 'gameover', reason: chess.in_checkmate() ? 'checkmate' : 'draw', fen: r.fen, pgn: r.pgn });
        // keep room for short while
        setTimeout(() => { rooms.delete(roomId); }, 1000 * 60 * 5);
      }
    }

    // Chat
    else if (data.type === 'chat') {
      const roomId = ws.room; if (!roomId) return;
      const r = rooms.get(roomId); if (!r) return;
      const text = String(data.text || '').slice(0, 400);
      const sender = (r.players[ws.playerId] && r.players[ws.playerId].name) || 'Guest';
      const msgObj = { sender, text, ts: Date.now() };
      r.chat.push(msgObj);
      broadcastRoom(r, { type: 'chat', message: msgObj });
    }

    // Resign
    else if (data.type === 'resign') {
      const roomId = ws.room; if (!roomId) return;
      const r = rooms.get(roomId); if (!r) return;
      const winnerColor = r.players[ws.playerId].color === 'white' ? 'black' : 'white';
      broadcastRoom(r, { type: 'resign', winner: winnerColor });
      setTimeout(() => { rooms.delete(roomId); }, 1000 * 60 * 2);
    }

    // Offer draw
    else if (data.type === 'offer_draw') {
      const roomId = ws.room; if (!roomId) return;
      const r = rooms.get(roomId); if (!r) return;
      broadcastRoom(r, { type: 'offer_draw', from: r.players[ws.playerId].name });
    }

    // Accept draw
    else if (data.type === 'accept_draw') {
      const roomId = ws.room; if (!roomId) return;
      const r = rooms.get(roomId); if (!r) return;
      broadcastRoom(r, { type: 'draw', message: 'Draw accepted' });
      setTimeout(() => { rooms.delete(roomId); }, 1000 * 60 * 2);
    }

    // Rematch
    else if (data.type === 'rematch') {
      const roomId = ws.room; if (!roomId) return;
      const r = rooms.get(roomId); if (!r) return;
      // reset chess and notify
      r.chess = new Chess();
      r.fen = r.chess.fen();
      r.pgn = '';
      broadcastRoom(r, { type: 'rematch', fen: r.fen });
    }
  });

  ws.on('close', () => {
    const roomId = ws.room;
    if (!roomId) return;
    const r = rooms.get(roomId);
    if (!r) return;

    // Remove player
    delete r.players[ws.playerId];
    r.order = r.order.filter(id => id !== ws.playerId);
    // Notify remaining player
    broadcastRoom(r, { type: 'peer-left' });
    // If no players left, delete room
    if (Object.keys(r.players).length === 0) rooms.delete(roomId);
  });
});

// heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { }
  });
}, 30000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('WebSocket server listening on', PORT));