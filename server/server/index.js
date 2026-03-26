require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

const waitingQueue = [];
const roomBySocket = new Map();
const peerBySocket = new Map();

function removeFromQueue(socketId) {
  for (let i = waitingQueue.length - 1; i >= 0; i -= 1) {
    if (waitingQueue[i] === socketId) {
      waitingQueue.splice(i, 1);
    }
  }
}

function sanitizeQueue(ioServer) {
  const seen = new Set();

  for (let i = waitingQueue.length - 1; i >= 0; i -= 1) {
    const socketId = waitingQueue[i];
    const exists = ioServer.sockets.sockets.has(socketId);
    const alreadySeen = seen.has(socketId);
    const alreadyInRoom = roomBySocket.has(socketId);

    if (!exists || alreadySeen || alreadyInRoom) {
      waitingQueue.splice(i, 1);
      continue;
    }

    seen.add(socketId);
  }
}

function resetPeerState(socketId) {
  const roomId = roomBySocket.get(socketId);
  if (roomId) {
    roomBySocket.delete(socketId);
  }
  peerBySocket.delete(socketId);
}

function pairSockets(socketA, socketB) {
  const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  socketA.join(roomId);
  socketB.join(roomId);

  roomBySocket.set(socketA.id, roomId);
  roomBySocket.set(socketB.id, roomId);
  peerBySocket.set(socketA.id, socketB.id);
  peerBySocket.set(socketB.id, socketA.id);

  socketA.emit('matched', {
    roomId,
    peerId: socketB.id,
    initiator: true,
  });

  socketB.emit('matched', {
    roomId,
    peerId: socketA.id,
    initiator: false,
  });
}

function tryMatch(ioServer) {
  sanitizeQueue(ioServer);

  while (waitingQueue.length >= 2) {
    const firstId = waitingQueue.shift();
    const secondId = waitingQueue.shift();

    const firstSocket = ioServer.sockets.sockets.get(firstId);
    const secondSocket = ioServer.sockets.sockets.get(secondId);

    if (!firstSocket || !secondSocket || firstId === secondId) {
      if (firstSocket) {
        waitingQueue.unshift(firstId);
      }
      sanitizeQueue(ioServer);
      continue;
    }

    pairSockets(firstSocket, secondSocket);
  }
}

function enqueueForMatch(ioServer, socket) {
  if (roomBySocket.has(socket.id)) {
    return;
  }

  removeFromQueue(socket.id);
  waitingQueue.push(socket.id);
  socket.emit('waiting');
  tryMatch(ioServer);
}

function notifyPeerAndCleanup(socket, reason) {
  const peerId = peerBySocket.get(socket.id);
  const roomId = roomBySocket.get(socket.id);

  if (roomId) {
    socket.leave(roomId);
  }

  resetPeerState(socket.id);

  if (!peerId) {
    return null;
  }

  const peerSocket = io.sockets.sockets.get(peerId);

  peerBySocket.delete(peerId);
  roomBySocket.delete(peerId);

  if (peerSocket && roomId) {
    peerSocket.leave(roomId);
    peerSocket.emit(reason, { from: socket.id });
  }

  return peerSocket;
}

io.on('connection', (socket) => {
  socket.data.autoSearch = false;

  socket.on('set-auto-search', ({ enabled }) => {
    socket.data.autoSearch = Boolean(enabled);
  });

  socket.on('join-random', () => {
    removeFromQueue(socket.id);
    notifyPeerAndCleanup(socket, 'peer-left');
    enqueueForMatch(io, socket);
  });

  socket.on('signal', ({ roomId, signal }) => {
    if (!roomId || !signal) {
      return;
    }

    if (roomBySocket.get(socket.id) !== roomId) {
      return;
    }

    socket.to(roomId).emit('signal', {
      from: socket.id,
      signal,
    });
  });

  socket.on('chat-message', ({ roomId, message }) => {
    if (!roomId || typeof message !== 'string') {
      return;
    }

    if (roomBySocket.get(socket.id) !== roomId) {
      return;
    }

    const normalized = message.trim().slice(0, 500);
    if (!normalized) {
      return;
    }

    socket.to(roomId).emit('chat-message', {
      from: socket.id,
      message: normalized,
      createdAt: Date.now(),
    });
  });

  socket.on('next-user', () => {
    const peerSocket = notifyPeerAndCleanup(socket, 'peer-next');

    if (peerSocket && peerSocket.data.autoSearch) {
      enqueueForMatch(io, peerSocket);
    }

    enqueueForMatch(io, socket);
  });

  socket.on('leave-room', () => {
    const peerSocket = notifyPeerAndCleanup(socket, 'peer-left');

    if (peerSocket && peerSocket.data.autoSearch) {
      enqueueForMatch(io, peerSocket);
    }
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    const peerSocket = notifyPeerAndCleanup(socket, 'peer-disconnected');

    if (peerSocket && peerSocket.data.autoSearch) {
      enqueueForMatch(io, peerSocket);
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
