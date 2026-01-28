require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const config = require('./src/config');
const { handleTranscription } = require('./src/services/transcription.service');
const { recordingSessions, startRecording, stopRecording, startRecordingForPeer } = require('./recording-service');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: '*' } });

let worker;
const rooms = new Map();
const transcriptionSessions = new Map();

async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });
  worker.on('died', () => setTimeout(() => process.exit(1), 2000));
  return worker;
}

async function getOrCreateRoom(roomId, password = null) {
  if (!rooms.has(roomId)) {
    const router = await worker.createRouter({ mediaCodecs: config.mediaCodecs });
    rooms.set(roomId, {
      router,
      peers: new Map(),
      password,
      hostId: null,
      whiteboard: { strokes: [], background: '#ffffff' },
      notes: ''
    });
  }
  return rooms.get(roomId);
}

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomId, username, password }, callback) => {
    try {
      let room = await getOrCreateRoom(roomId, password);
      if (room.password && room.password !== password) return callback({ error: 'Invalid password' });

      if (!room.hostId) room.hostId = socket.id;
      room.peers.set(socket.id, { username, transports: new Map(), producers: new Map(), consumers: new Map(), joinedAt: Date.now() });

      socket.join(roomId);
      callback({ rtpCapabilities: room.router.rtpCapabilities, isHost: room.hostId === socket.id });
      socket.to(roomId).emit('user-joined', { socketId: socket.id, username });
    } catch (e) { callback({ error: e.message }); }
  });

  socket.on('start-transcription', async (data) => {
    const session = await handleTranscription(socket, io, rooms, recordingSessions, data);
    if (session) transcriptionSessions.set(socket.id, session);
  });

  socket.on('audio-chunk', ({ audioData }) => {
    const session = transcriptionSessions.get(socket.id);
    if (session?.isActive) session.audioStream.write(Buffer.from(new Int16Array(audioData).buffer));
  });

  socket.on('create-transport', async ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    const transport = await room.router.createWebRtcTransport(config.webRtcTransportOptions);
    room.peers.get(socket.id).transports.set(transport.id, transport);
    callback({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
  });

  socket.on('disconnect', () => {
    transcriptionSessions.get(socket.id)?.audioStream?.end();
    transcriptionSessions.delete(socket.id);
  });
});

async function startServer() {
  await createWorker();
  server.listen(config.PORT, '0.0.0.0', () => console.log(`Server running on port ${config.PORT}`));
}

startServer();
