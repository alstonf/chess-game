import React, { useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'

export default function App(){
  const [wsUrl, setWsUrl] = useState('wss://chess-game-fzz0.onrender.com');
  const [roomId, setRoomId] = useState('room1');
  const [name, setName] = useState('Player');
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [color, setColor] = useState('white');
  const [fen, setFen] = useState(new Chess().fen());
  const chessRef = useRef(new Chess());
  const [log, setLog] = useState([]);
  const [moves, setMoves] = useState([]);
  const [chat, setChat] = useState([]);
  const [chatText, setChatText] = useState('');
  const [opponentName, setOpponentName] = useState('Waiting...');
  const [turn, setTurn] = useState('white');
  const reconnectTimerRef = useRef(null);

  useEffect(()=>{ chessRef.current = new Chess(fen); }, [fen]);

  // connect handler with auto-retry
  function connect(){
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      addLog('Connected');
      // join room
      ws.send(JSON.stringify({ type: 'join', room: roomId, name }));
    };

    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'joined'){
        setColor(data.color);
        setFen(data.fen);
        addLog(`Joined as ${data.color}`);
      }
      if (data.type === 'waiting') addLog(data.message);
      if (data.type === 'start'){
        setFen(data.fen);
        setMoves([]);
        setLog(l => [...l, 'Game started']);
        // set opponent name
        const names = data.names || [];
        if (names.length === 2){
          const opp = names.find(n => n !== name) || 'Opponent';
          setOpponentName(opp);
        }
      }
      if (data.type === 'move'){
        setFen(data.fen);
        setMoves(m => [...m, data.move.san]);
        setTurn(data.turn);
        addLog(`Move: ${data.move.san}`);
      }
      if (data.type === 'invalid') addLog('Illegal move');
      if (data.type === 'gameover') addLog('Game over: ' + data.reason);
      if (data.type === 'chat') setChat(c => [...c, data.message]);
      if (data.type === 'peer-left') addLog('Opponent left');
      if (data.type === 'resign') addLog('Resigned — winner: ' + data.winner);
      if (data.type === 'rematch'){
        setFen(data.fen);
        setMoves([]);
        addLog('Rematch started');
      }
    };

    ws.onclose = () => {
      setConnected(false);
      addLog('Disconnected — will retry');
      // auto-reconnect with exponential backoff
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => addLog('Connection error');
  }

  useEffect(()=>{
    // cleanup
    return ()=>{
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (socketRef.current) socketRef.current.close();
    }
  },[]);

  function addLog(t){ setLog(l => [...l, `${new Date().toLocaleTimeString()}: ${t}`]); }

  function onPieceDrop(sourceSquare, targetSquare){
    // create move and send to server
    const move = { from: sourceSquare, to: targetSquare, promotion: 'q' };
    try {
      // optimistic local validation
      const chess = new Chess(chessRef.current.fen());
      const legal = chess.move(move);
      if (!legal) { addLog('Illegal move'); return false; }
      // rollback optimistic move
      // send to server
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'move', move }));
      } else {
        addLog('Not connected');
      }
      return true;
    } catch (e) { addLog('Move error'); return false; }
  }

  function sendChat(){
    if (!chatText.trim()) return;
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN){
      socketRef.current.send(JSON.stringify({ type: 'chat', text: chatText }));
      setChatText('');
    } else addLog('Not connected');
  }

  function resign(){ if (socketRef.current) socketRef.current.send(JSON.stringify({ type: 'resign' })); }
  function offerDraw(){ if (socketRef.current) socketRef.current.send(JSON.stringify({ type: 'offer_draw' })); }
  function acceptDraw(){ if (socketRef.current) socketRef.current.send(JSON.stringify({ type: 'accept_draw' })); }
  function rematch(){ if (socketRef.current) socketRef.current.send(JSON.stringify({ type: 'rematch' })); }

  return (
    <div className="app">
      <div className="header">
        <h2>Online Chess — Improved</h2>
        <div style={{marginLeft:'auto'}}>
          <strong>Status:</strong> {connected ? 'Connected' : 'Disconnected'} — You are <strong>{color}</strong>
        </div>
      </div>

      <div className="controls">
        <input value={wsUrl} onChange={e=>setWsUrl(e.target.value)} style={{width:360,padding:8}} />
        <input value={roomId} onChange={e=>setRoomId(e.target.value)} placeholder="room id" />
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" />
        <button className="btn" onClick={connect}>Connect / Join</button>
        <button className="btn small" onClick={resign}>Resign</button>
        <button className="btn small" onClick={offerDraw}>Offer Draw</button>
        <button className="btn small" onClick={rematch}>Rematch</button>
      </div>

      <div className="container">
        <div className="left panel">
          <Chessboard
            id="PlayBoard"
            position={fen}
            onPieceDrop={(s,t) => onPieceDrop(s,t)}
            boardOrientation={color === 'black' ? 'black' : 'white'}
            boardWidth={600}
            arePiecesDraggable={true}
            customBoardStyle={{ borderRadius: '8px', boxShadow: '0 4px 12px rgba(16,24,40,0.08)' }}
          />
          <div className="statusline">Turn: {turn} | Opponent: {opponentName}</div>
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
            <div className="log">
              {chat.map((c,i)=>(<div key={i}><strong>{c.sender}:</strong> {c.text}</div>))}
            </div>
            <div className="chat-input">
              <input value={chatText} onChange={e=>setChatText(e.target.value)} placeholder="Say hello" />
              <button className="btn" onClick={sendChat}>Send</button>
            </div>
          </div>

          <div className="panel" style={{marginTop:12}}>
            <h4>Logs</h4>
            <div className="log">
              {log.map((l,i)=>(<div key={i}>{l}</div>))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}