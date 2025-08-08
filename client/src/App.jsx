import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import Chessboard from "chessboardjsx";
import { Chess } from "chess.js";

const socket = io(import.meta.env.VITE_SERVER_URL || "http://localhost:3001");

export default function App() {
  const [game, setGame] = useState(new Chess());
  const [color, setColor] = useState(null); // 'white' or 'black'
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);

  // Listen for server events
  useEffect(() => {
    socket.on("color", (assignedColor) => {
      setColor(assignedColor);
    });

    socket.on("move", (move) => {
      const updatedGame = new Chess(game.fen());
      updatedGame.move(move);
      setGame(updatedGame);
    });

    socket.on("gameState", (fen) => {
      const updatedGame = new Chess(fen);
      setGame(updatedGame);
    });

    socket.on("disconnect", () => {
      console.log("Disconnected from server");
    });

    return () => {
      socket.off("color");
      socket.off("move");
      socket.off("gameState");
      socket.off("disconnect");
    };
  }, [game]);

  // Join room
  const joinRoom = () => {
    if (roomId.trim()) {
      socket.emit("joinRoom", roomId);
      setJoined(true);
    }
  };

  // Handle move
  const handleMove = (move) => {
    if (game.turn() !== color[0]) return; // Not your turn
    const updatedGame = new Chess(game.fen());
    const result = updatedGame.move(move);
    if (result) {
      setGame(updatedGame);
      socket.emit("move", { roomId, move });
    }
  };

  return (
    <div style={{ padding: "20px", textAlign: "center" }}>
      {!joined ? (
        <div>
          <h1>Join a Chess Game</h1>
          <input
            type="text"
            placeholder="Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <button onClick={joinRoom}>Join</button>
        </div>
      ) : (
        <div>
          <h2>You are playing as {color}</h2>
          <Chessboard
            width={window.innerWidth < 600 ? 320 : 500}
            position={game.fen()}
            orientation={color}
            onDrop={({ sourceSquare, targetSquare }) =>
              handleMove({ from: sourceSquare, to: targetSquare, promotion: "q" })
            }
          />
        </div>
      )}
    </div>
  );
}
