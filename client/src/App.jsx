import React, { useEffect, useState, useRef } from 'react'
import { Chess } from 'chess.js'

export default function App(){
  const [wsUrl, setWsUrl] = useState('ws://localhost:3001');
  const [roomId, setRoomId] = useState('room1');
  const [name, setName] = useState('Player');
  const [conn, setConn] = useState(null);
  const [status, setStatus] = useState('disconnected');
  const [color, setColor] = useState(null);
  const [fen, setFen] = useState(new Chess().fen());
  const chessRef = useRef(new Chess());
  const [selected, setSelected] = useState(null);
  const [log, setLog] = useState([]);

  useEffect(()=>{
    chessRef.current = new Chess(fen);
  },[fen]);

  function connect(){
    const socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      setStatus('connected');
      socket.send(JSON.stringify({ type: 'join', room: roomId, name }));
    }
    socket.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'joined') setLog(l=>[...l, 'Joined as ' + data.color]);
      if (data.type === 'start'){ setFen(data.fen); setColor(data.color); setLog(l=>[...l, 'Game started']); }
      if (data.type === 'move'){ setFen(data.fen); setLog(l=>[...l, `Move: ${data.move.san}`]); }
      if (data.type === 'invalid') setLog(l=>[...l, 'Invalid move']);
      if (data.type === 'gameover') setLog(l=>[...l, 'Game over: ' + data.reason]);
      if (data.type === 'peer-left') setLog(l=>[...l, 'Opponent left']);
      if (data.type === 'resign') setLog(l=>[...l, 'Player resigned']);
    }
    socket.onclose = ()=>{ setStatus('disconnected'); setConn(null); setLog(l=>[...l,'disconnected']); }
    socket.onerror = (e)=>{ setLog(l=>[...l,'error']); }
    setConn(socket);
  }

  function squareColor(i,j){
    return (i + j) % 2 === 0 ? 'light' : 'dark';
  }

  function renderBoard(){
    const chess = new Chess(fen);
    const board = chess.board(); // 8x8 array starting from rank 8 to 1
    const squares = [];
    for (let rank = 7; rank >= 0; rank--) {
      for (let file = 0; file < 8; file++){
        const p = board[rank][file];
        const fileChar = 'abcdefgh'[file];
        const rankNum = rank + 1;
        const coord = fileChar + rankNum;
        const pieceChar = p ? unicodeForPiece(p) : '';
        squares.push(
          <div key={coord}
               onClick={() => handleSquareClick(coord)}
               className={`square ${squareColor(file, rank)}`}>
            {pieceChar}
          </div>
        )
      }
    }
    return squares;
  }

  function unicodeForPiece(p){
    const map = {
      p: '\u265F', r: '\u265C', n: '\u265E', b: '\u265D', q: '\u265B', k: '\u265A',
      P: '\u2659', R: '\u2656', N: '\u2658', B: '\u2657', Q: '\u2655', K: '\u2654'
    }
    const key = p.color === 'w' ? p.type.toUpperCase() : p.type.toLowerCase();
    return map[key] || '';
  }

  function handleSquareClick(coord){
    if (!conn || conn.readyState !== WebSocket.OPEN) return setLog(l=>[...l,'Not connected']);
    const chess = new Chess(fen);
    if (!selected){
      // pick a piece
      const moves = chess.moves({ square: coord, verbose: true });
      if (moves.length === 0) return;
      setSelected(coord);
      setLog(l=>[...l,'Selected ' + coord]);
    } else {
      // attempt move
      const move = { from: selected, to: coord };
      // if pawn promotion needed, default to queen
      const legal = chess.move({ ...move, promotion: 'q' });
      if (!legal){ setLog(l=>[...l,'Illegal move']); setSelected(null); return; }
      // rollback local tentative move (we'll wait for server)
      chess.undo();
      // send move to server
      conn.send(JSON.stringify({ type: 'move', move }));
      setSelected(null);
    }
  }

  function resign(){ if (!conn) return; conn.send(JSON.stringify({ type: 'resign' })); }

  return (
    <div className="app">
      <div className="header">
        <h2>Simple Online Chess</h2>
        <div style={{marginLeft: 'auto'}}>
          <strong>Status:</strong> {status} {color ? ` — you are ${color}` : ''}
        </div>
      </div>

      <div className="controls">
        <input value={wsUrl} onChange={e=>setWsUrl(e.target.value)} placeholder="ws://server:3001" />
        <input value={roomId} onChange={e=>setRoomId(e.target.value)} placeholder="room id" />
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" />
        <button onClick={connect}>Connect / Join</button>
        <button onClick={resign}>Resign</button>
      </div>

      <div style={{display:'flex',gap:24}}>
        <div>
          <div className="board">{renderBoard()}</div>
          <div className="status">FEN: {fen}</div>
        </div>
        <div style={{width:300}}>
          <h4>Log</h4>
          <div style={{height:360,overflow:'auto',background:'#fafafa',padding:8}}>
            {log.map((l,i)=>(<div key={i}>{l}</div>))}
          </div>
        </div>
      </div>
    </div>
  )
}