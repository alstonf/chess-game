import React, { useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { io } from 'socket.io-client'

export default function App(){
  const [serverUrl, setServerUrl] = useState('https://chess-game-fzz0.onrender.com');
  const [roomId, setRoomId] = useState('room1');
  const [name, setName] = useState('Player');
  const [desiredTime, setDesiredTime] = useState(300); // seconds
  const socketRef = useRef(null);
  const chessRef = useRef(new Chess());
  const [fen, setFen] = useState(new Chess().fen());
  const [color, setColor] = useState('white');
  const [connected, setConnected] = useState(false);
  const [moves, setMoves] = useState([]);
  const [chat, setChat] = useState([]);
  const [timers, setTimers] = useState({ white: 300, black: 300 });
  const [turn, setTurn] = useState('white');
  const [status, setStatus] = useState('idle');

  useEffect(()=>{ chessRef.current = new Chess(fen); }, [fen]);

  function connect(){
    if (socketRef.current) socketRef.current.disconnect();
    const socket = io(serverUrl, { transports: ['websocket'], reconnectionAttempts: 5 });
    socketRef.current = socket;

    socket.on('connect', () => { setConnected(true); setStatus('connected');
      socket.emit('join', { roomId, name, desiredTime });
    });

    socket.on('joined', ({ color: c, fen: f, timers: t }) => { setColor(c); setFen(f); setTimers(t); setStatus('joined'); });
    socket.on('waiting', (msg) => setStatus(msg));
    socket.on('start', ({ fen: f, timers: t, turn: tr }) => { setFen(f); setTimers(t); setTurn(tr); setMoves([]); setStatus('playing'); });
    socket.on('move', ({ move, fen: f, turn: tr, timers: t }) => { setFen(f); setMoves(m => [...m, move.san]); setTurn(tr); setTimers(t); });
    socket.on('timers', ({ timers: t, turn: tr }) => { setTimers(t); setTurn(tr); });
    socket.on('timeouts', ({ winner }) => { setStatus('timeout'); alert('Time over — winner: ' + winner); });
    socket.on('gameover', ({ reason }) => { setStatus('gameover'); alert('Game over: ' + reason); });
    socket.on('chat', (msg) => setChat(c => [...c, msg]));
    socket.on('peer-left', () => setStatus('opponent-left'));
    socket.on('resign', ({ winner }) => { setStatus('resigned'); alert('Resign — winner: ' + winner); });
    socket.on('rematch', ({ fen: f, timers: t }) => { setFen(f); setTimers(t); setMoves([]); setStatus('rematch'); });

    socket.on('disconnect', () => { setConnected(false); setStatus('disconnected'); });
  }

  function onPieceDrop(from, to){
    // local validation
    const chess = new Chess(chessRef.current.fen());
    const legal = chess.move({ from, to, promotion: 'q' });
    if (!legal) return false;
    // rollback
    chess.undo();
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('move', { from, to, promotion: 'q' });
    } else {
      alert('Not connected');
    }
    return true;
  }

  function sendChat(text){ if (!text) return; socketRef.current.emit('chat', { text }); }
  function resign(){ socketRef.current.emit('resign'); }
  function rematch(){ socketRef.current.emit('rematch'); }

  function formatTime(s){ const m = Math.floor(s/60); const sec = s % 60; return `${m}:${sec.toString().padStart(2,'0')}` }

  return (
    <div className="app">
      <div className="header">
        <h2>Online Chess — Stable</h2>
        <div style={{marginLeft:'auto'}}>{connected ? 'Connected' : 'Disconnected'} — {status}</div>
      </div>

      <div className="controls">
        <input value={serverUrl} onChange={e=>setServerUrl(e.target.value)} placeholder="https://your-render-app.onrender.com" />
        <input value={roomId} onChange={e=>setRoomId(e.target.value)} placeholder="room id" />
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="your name" />
        <input type="number" value={desiredTime} onChange={e=>setDesiredTime(Number(e.target.value))} style={{width:120}} />
        <button className="btn" onClick={connect}>Connect / Join</button>
        <button className="btn" onClick={resign}>Resign</button>
        <button className="btn" onClick={rematch}>Rematch</button>
      </div>

      <div className="container">
        <div className="left panel">
          <div className="timer">
            <div>White: <span className="time">{formatTime(timers.white)}</span></div>
            <div>Black: <span className="time">{formatTime(timers.black)}</span></div>
          </div>

          <Chessboard
            id="PlayBoard"
            position={fen}
            onPieceDrop={(from,to)=>onPieceDrop(from,to)}
            boardOrientation={color === 'black' ? 'black' : 'white'}
            boardWidth={Math.min(640, window.innerWidth - 60)}
            arePiecesDraggable={true}
          />

          <div style={{marginTop:8}}>Turn: {turn}</div>
        </div>

        <div className="right">
          <div className="panel">
            <h4>Moves</h4>
            <div className="move-list">
              {moves.map((m,i)=>(<div key={i}>{i+1}. {m}</div>))}
            </div>
          </div>

          <div className="panel" style={{marginTop:12}}>
            <h4>Chat</h4>
            <div style={{maxHeight:200,overflow:'auto'}}>
              {chat.map((c,i)=>(<div key={i}><strong>{c.sender}:</strong> {c.text}</div>))}
            </div>
            <div className="chat-input">
              <input placeholder="Say hello" onKeyDown={(e)=>{ if(e.key==='Enter'){ sendChat(e.target.value); e.target.value=''; } }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}