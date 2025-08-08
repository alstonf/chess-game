
// server/server.js
const http = require('http');
const WebSocket = require('ws');
const { Chess } = require('chess.js');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// rooms: roomId -> { players: [ws, ws], chess: Chess }
const rooms = new Map();

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }

    if (data.type === 'join') {
      const { room, name } = data;
      if (!room) return send(ws, { type: 'error', message: 'room required' });

      let r = rooms.get(room);
      if (!r) {
        r = { players: [], chess: new Chess(), names: [] };
        rooms.set(room, r);
      }

      if (r.players.length >= 2) {
        return send(ws, { type: 'error', message: 'room full' });
      }

      r.players.push(ws);
      r.names.push(name || 'Guest');
      ws.room = room;
      ws.playerIndex = r.players.length - 1; // 0 or 1

      send(ws, { type: 'joined', color: ws.playerIndex === 0 ? 'white' : 'black', index: ws.playerIndex });

      // If two players, start the game
      if (r.players.length === 2) {
        // send start to both
        r.players.forEach((p, idx) => {
          send(p, { type: 'start', color: idx === 0 ? 'white' : 'black', names: r.names, fen: r.chess.fen() });
        });
      }
    }

    else if (data.type === 'move') {
      const room = ws.room;
      if (!room) return send(ws, { type: 'error', message: 'not in room' });

      const r = rooms.get(room);
      if (!r) return send(ws, { type: 'error', message: 'room not found' });

      // Validate and apply move on server-side
      const move = data.move; // {from: 'e2', to: 'e4', promotion?: 'q'}
      const chess = r.chess;
      const result = chess.move(move);
      if (!result) return send(ws, { type: 'invalid', message: 'illegal move' });

      // Broadcast the move and new fen to both players
      r.players.forEach((p) => send(p, { type: 'move', move: result, fen: chess.fen(), pgn: chess.pgn() }));

      // If game over, notify
      if (chess.game_over()) {
        r.players.forEach((p) => send(p, { type: 'gameover', reason: chess.in_checkmate() ? 'checkmate' : 'draw', fen: chess.fen(), pgn: chess.pgn() }));
        // keep room for rematch or clear it after a timeout
        setTimeout(() => { rooms.delete(room); }, 1000 * 60 * 5);
      }
    }

    else if (data.type === 'resign') {
      const room = ws.room; if (!room) return;
      const r = rooms.get(room); if (!r) return;
      const winnerIdx = ws.playerIndex === 0 ? 1 : 0;
      r.players.forEach((p, idx) => send(p, { type: 'resign', winner: winnerIdx, fen: r.chess.fen() }));
      setTimeout(() => { rooms.delete(room); }, 1000 * 60 * 2);
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    const r = rooms.get(room);
    if (!r) return;
    // notify other player
    r.players.forEach((p) => { if (p !== ws) send(p, { type: 'peer-left' }); });
    rooms.delete(room);
  });
});

// heartbeat to detect dead clients
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('WebSocket server listening on', PORT));

