require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');

const config = require('./src/config');
const logger = require('./src/utils/logger');
const roomManager = require('./src/services/room.service');
const { startRecording, stopRecording } = require('./src/services/recording.service');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: '*' } });

// Health Check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Socket Handler
io.on('connection', (socket) => {
  logger.info(`New connection: ${socket.id}`);

  socket.on('join-room', async (data, callback) => {
    try {
      const result = await roomManager.joinRoom(socket, data);
      callback(result);
      socket.to(data.roomId).emit('user-joined', { 
        socketId: socket.id, 
        username: data.recorder ? 'System Recorder' : data.username 
      });
    } catch (error) {
      logger.error(`Join room error: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on('create-transport', async ({ roomId }, callback) => {
    try {
      const room = await roomManager.getOrCreateRoom(roomId);
      const transport = await room.router.createWebRtcTransport(config.webRtcTransportOptions);
      
      const peer = room.peers.get(socket.id);
      if (peer) peer.transports.set(transport.id, transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (error) {
      logger.error(`Transport creation error: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on('start-recording', async ({ roomId }, callback) => {
    try {
      const session = await startRecording(roomId, socket.id, io, roomManager.rooms);
      io.to(roomId).emit('recording-started', { recordingId: session.recordingId });
      callback({ success: true });
    } catch (error) {
      logger.error(`Start recording error: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on('stop-recording', async ({ roomId }, callback) => {
    try {
      const result = await stopRecording(roomId);
      io.to(roomId).emit('recording-stopped', result);
      callback({ success: true, result });
    } catch (error) {
      logger.error(`Stop recording error: ${error.message}`);
      callback({ error: error.message });
    }
  });

  socket.on('disconnect', () => {
    roomManager.handleDisconnect(socket.id);
  });
});

async function bootstrap() {
  try {
    const worker = await mediasoup.createWorker({
      logLevel: config.mediasoup?.logLevel || 'warn',
      rtcMinPort: config.mediasoup?.rtcMinPort || 10000,
      rtcMaxPort: config.mediasoup?.rtcMaxPort || 10100,
    });

    await roomManager.initialize(worker);

    server.listen(config.PORT, '0.0.0.0', () => {
      logger.info(`🚀 Powerful Backend running on port ${config.PORT}`);
    });
  } catch (error) {
    logger.error(`Bootstrap failed: ${error.message}`);
    process.exit(1);
  }
}

bootstrap();
