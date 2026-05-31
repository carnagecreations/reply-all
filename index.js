// REPLY ALL — Server
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { RoomManager, PHASES } from './game.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// Serve the built React client from ../client/dist (if it exists)
const distPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(distPath));

const server = createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new RoomManager();

// Map wsId -> { ws, roomCode, playerId }
const connections = new Map();
let connCounter = 0;

function wsId(ws) {
  if (!ws._connId) ws._connId = `conn_${++connCounter}`;
  return ws._connId;
}

function broadcast(room, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  connections.forEach(({ ws, roomCode }) => {
    if (roomCode === room.code && ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastState(room) {
  const state = room.getPublicState();
  connections.forEach(({ ws, roomCode, playerId }) => {
    if (roomCode === room.code && ws.readyState === WebSocket.OPEN) {
      const privateState = room.getPlayerPrivateState(playerId);
      sendTo(ws, { type: 'STATE_UPDATE', state, private: privateState });
    }
  });
}

function startWritingPhase(room) {
  room.startWriting();
  broadcastState(room);

  room.timer = setTimeout(() => {
    if (room.phase === PHASES.WRITING) {
      advanceToReveal(room);
    }
  }, room.settings.writingTime * 1000 + 1000);
}

function advanceToReveal(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.startReveal();
  broadcastState(room);
}

function advanceReveal(room) {
  const hasMore = room.nextReveal();
  broadcastState(room);
  if (!hasMore) {
    // All revealed — wait for host to advance, or auto after a pause
  }
}

function startVotingPhase(room) {
  room.startVoting();
  broadcastState(room);

  room.timer = setTimeout(() => {
    if (room.phase === PHASES.VOTING) {
      finishVoting(room);
    }
  }, room.settings.votingTime * 1000 + 1000);
}

function finishVoting(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.tallyVotes();
  broadcastState(room);
}

function checkAllSubmitted(room) {
  if (room.allSubmitted()) {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    advanceToReveal(room);
  }
}

function checkAllVoted(room) {
  if (room.allVoted()) {
    finishVoting(room);
  }
}

wss.on('connection', (ws) => {
  const id = wsId(ws);
  connections.set(id, { ws, roomCode: null, playerId: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const conn = connections.get(id);

    switch (msg.type) {
      case 'CREATE_ROOM': {
        const room = rooms.createRoom(msg.settings || {});
        const player = room.addPlayer(id, msg.name || 'Host', true);
        conn.roomCode = room.code;
        conn.playerId = id;
        sendTo(ws, { type: 'ROOM_CREATED', code: room.code, playerId: id });
        broadcastState(room);
        break;
      }

      case 'JOIN_ROOM': {
        const room = rooms.getRoom(msg.code);
        if (!room) {
          sendTo(ws, { type: 'ERROR', message: 'Room not found. Check the code and try again.' });
          return;
        }
        if (room.phase !== PHASES.LOBBY) {
          const existing = room.getAllPlayers().find(
            p => p.name.toLowerCase() === (msg.name || '').toLowerCase().trim()
          );
          if (existing && !existing.connected) {
            existing.connected = true;
            existing.id = id;
            conn.roomCode = room.code;
            conn.playerId = id;
            sendTo(ws, { type: 'JOINED', playerId: id, name: existing.name, color: existing.color });
            broadcastState(room);
            return;
          }
          sendTo(ws, { type: 'ERROR', message: 'Game is in progress. Contact the host to rejoin.' });
          return;
        }
        if (room.getAllPlayers().length >= 10) {
          sendTo(ws, { type: 'ERROR', message: 'Room is full (10 players maximum).' });
          return;
        }
        const nameTaken = room.getAllPlayers().some(
          p => p.name.toLowerCase() === (msg.name || '').toLowerCase().trim()
        );
        if (nameTaken) {
          sendTo(ws, { type: 'ERROR', message: 'That name is already taken. Please choose another.' });
          return;
        }
        const player = room.addPlayer(id, msg.name || 'Player');
        conn.roomCode = room.code;
        conn.playerId = id;
        sendTo(ws, { type: 'JOINED', playerId: id, name: player.name, color: player.color });
        broadcastState(room);
        break;
      }

      case 'START_GAME': {
        const room = rooms.getRoom(conn.roomCode);
        if (!room || conn.playerId !== room.hostId) return;
        if (room.getAllPlayers().filter(p => p.connected).length < 2) {
          sendTo(ws, { type: 'ERROR', message: 'Need at least 2 players to start.' });
          return;
        }
        room.startGame();
        broadcastState(room);
        break;
      }

      case 'START_WRITING': {
        const room = rooms.getRoom(conn.roomCode);
        if (!room || conn.playerId !== room.hostId) return;
        if (room.phase !== PHASES.PREMISE) return;
        startWritingPhase(room);
        break;
      }

      case 'SUBMIT_REPLY': {
        const room = rooms.getRoom(conn.roomCode);
        if (!room) return;
        const ok = room.submitReply(conn.playerId, msg.text || '');
        if (ok) {
          broadcastState(room);
          checkAllSubmitted(room);
        }
        break;
      }

      case 'NEXT_REVEAL': {
        const room = rooms.getRoom(conn.roomCode);
        if (!room || conn.playerId !== room.hostId) return;
        if (room.phase !== PHASES.REVEAL) return;
        advanceReveal(room);
        break;
      }

      case 'START_VOTING': {
        const room = rooms.getRoom(conn.roomCode);
        if (!room || conn.playerId !== room.hostId) return;
        if (room.phase !== PHASES.REVEAL) return;
        startVotingPhase(room);
        break;
      }

      case 'SUBMIT_VOTE': {
        const room = rooms.getRoom(conn.roomCode);
        if (!room) return;
        const ok = room.submitVote(conn.playerId, msg.targetId);
        if (ok) {
          broadcastState(room);
          checkAllVoted(room);
        }
        break;
      }

      case 'NEXT_ROUND': {
        const room = rooms.getRoom(conn.roomCode);
        if (!room || conn.playerId !== room.hostId) return;
        if (room.phase !== PHASES.SCORES) return;
        if (room.isGameOver()) {
          room.phase = PHASES.GAME_OVER;
          broadcastState(room);
        } else {
          room.startRound();
          broadcastState(room);
        }
        break;
      }

      case 'PING': {
        sendTo(ws, { type: 'PONG' });
        break;
      }

      case 'UPDATE_SETTINGS': {
        const room = rooms.getRoom(conn.roomCode);
        if (!room || conn.playerId !== room.hostId) return;
        if (room.phase !== PHASES.LOBBY) return;
        Object.assign(room.settings, msg.settings || {});
        broadcastState(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    const conn = connections.get(id);
    if (conn?.roomCode) {
      const room = rooms.getRoom(conn.roomCode);
      if (room) {
        room.removePlayer(conn.playerId);
        const graceTimer = setTimeout(() => {
          const player = room.players.get(conn.playerId);
          if (player && !player.connected) {
            broadcastState(room);
          }
        }, 5000);
        room.disconnectTimers.set(conn.playerId, graceTimer);
        broadcastState(room);
      }
    }
    connections.delete(id);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });
});

// REST: get room info
app.get('/api/room/:code', (req, res) => {
  const room = rooms.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    phase: room.phase,
    playerCount: room.getAllPlayers().filter(p => p.connected).length,
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Catch-all: send React app for client-side routes
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`REPLY ALL server running on port ${PORT}`);
});
