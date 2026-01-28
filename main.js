require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const config = require('./src/config');
const { handleTranscription } = require('./src/services/transcription.service');
const { recordingSessions, startRecording, stopRecording } = require('./src/services/recording.service');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: '*' } });

// Pre-create worker and shared router for common capabilities
let worker;
const rooms = new Map();
const transcriptionSessions = new Map();
let globalRtpCapabilities;

async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });
  worker.on('died', () => setTimeout(() => process.exit(1), 2000));
  
  // Pre-create a router to get global capabilities once
  const tempRouter = await worker.createRouter({ mediaCodecs: config.mediaCodecs });
  globalRtpCapabilities = tempRouter.rtpCapabilities;
  tempRouter.close();
  
  console.log('[MediaSoup] Worker and capabilities initialized');
  return worker;
}

async function getOrCreateRoom(roomId, password = null) {
  let room = rooms.get(roomId);
  if (!room) {
    const router = await worker.createRouter({ mediaCodecs: config.mediaCodecs });
    room = {
      router,
      peers: new Map(),
      password,
      hostId: null,
      whiteboard: { strokes: [], background: '#ffffff' },
      notes: ''
    };
    rooms.set(roomId, room);
  }
  return room;
}

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomId, username, password, recorder = false }, callback) => {
    try {
      // Faster room access/creation
      const room = await getOrCreateRoom(roomId, password);
      if (room.password && room.password !== password) return callback({ error: 'Invalid password' });

      if (!room.hostId && !recorder) room.hostId = socket.id;
      
      const peerData = { 
        username: recorder ? 'System Recorder' : username, 
        transports: new Map(), 
        producers: new Map(), 
        consumers: new Map(), 
        joinedAt: Date.now(),
        isRecorder: !!recorder
      };
      room.peers.set(socket.id, peerData);

      socket.join(roomId);
      
      // Respond IMMEDIATELY with cached global capabilities
      callback({ 
        rtpCapabilities: globalRtpCapabilities, 
        isHost: room.hostId === socket.id 
      });
      
      // Handle notifications asynchronously after user is already "in"
      setImmediate(() => {
        socket.to(roomId).emit('user-joined', { socketId: socket.id, username });
      });
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

  socket.on('start-recording', async ({ roomId }, callback) => {
    try {
      const session = await startRecording(roomId, socket.id, io, rooms);
      io.to(roomId).emit('recording-started', { recordingId: session.recordingId });
      callback({ success: true });
    } catch (e) { callback({ error: e.message }); }
  });

  socket.on('stop-recording', async ({ roomId }, callback) => {
    try {
      const result = await stopRecording(roomId);
      io.to(roomId).emit('recording-stopped', result);
      callback({ success: true, result });
    } catch (e) { callback({ error: e.message }); }
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
