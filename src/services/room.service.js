const mediasoup = require('mediasoup');
const config = require('../config');
const { logUserJoin } = require('./aws.service');
const logger = require('../utils/logger');

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.worker = null;
    this.globalRtpCapabilities = null;
  }

  async initialize(worker) {
    this.worker = worker;
    const tempRouter = await this.worker.createRouter({ mediaCodecs: config.mediaCodecs });
    this.globalRtpCapabilities = tempRouter.rtpCapabilities;
    tempRouter.close();
    logger.info('RoomManager initialized with global capabilities');
  }

  async getOrCreateRoom(roomId, password = null) {
    let room = this.rooms.get(roomId);
    if (!room) {
      const router = await this.worker.createRouter({ mediaCodecs: config.mediaCodecs });
      room = {
        id: roomId,
        router,
        peers: new Map(),
        password,
        hostId: null,
        whiteboard: { strokes: [], background: '#ffffff' },
        notes: '',
        createdAt: new Date(),
        settings: {
          video: { res: '720p', fps: 30, bitrate: 2500 },
          audio: { rate: 48000, channels: 2, echoCancellation: true }
        }
      };
      this.rooms.set(roomId, room);
      
      // Auto-cleanup room if empty after 5 minutes
      room.cleanupTimeout = null;
      
      await logUserJoin(roomId, {
          action: 'ROOM_CREATED',
          hasPassword: !!password,
          timestamp: new Date().toISOString()
      }).catch(err => logger.error(`DynamoDB logging failed for room ${roomId}:`, err));
      
      logger.info(`New room created: ${roomId}`);
    }
    return room;
  }

  async joinRoom(socket, { roomId, username, password, recorder = false }) {
    const room = await this.getOrCreateRoom(roomId, password);
    
    // Clear cleanup timer if someone joins
    if (room.cleanupTimeout) {
      clearTimeout(room.cleanupTimeout);
      room.cleanupTimeout = null;
      logger.info(`Cleanup timer cancelled for room ${roomId}`);
    }

    if (room.password && room.password !== password) {
      throw new Error('Invalid password');
    }

    if (!room.hostId && !recorder) {
      room.hostId = socket.id;
    }

    const peerData = {
      id: socket.id,
      username: recorder ? 'System Recorder' : username,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      joinedAt: new Date(),
      isRecorder: !!recorder
    };

    room.peers.set(socket.id, peerData);
    socket.join(roomId);

    // Sync active producers to the new peer
    const activeProducers = [];
    for (const [peerId, peer] of room.peers.entries()) {
      if (peerId !== socket.id) {
        for (const [producerId, producer] of peer.producers.entries()) {
          activeProducers.push({
            socketId: peerId,
            producerId: producerId,
            kind: producer.kind
          });
        }
      }
    }
    
    if (activeProducers.length > 0) {
      socket.emit('active-producers', activeProducers);
    }

    // Async logging
    logUserJoin(roomId, {
      socketId: socket.id,
      username: peerData.username,
      isRecorder: peerData.isRecorder,
      action: 'USER_JOINED'
    }).catch(err => logger.error(`User join logging failed:`, err));

    return {
      rtpCapabilities: this.globalRtpCapabilities,
      isHost: room.hostId === socket.id
    };
  }

  handleDisconnect(socketId) {
    for (const [roomId, room] of this.rooms) {
      if (room.peers.has(socketId)) {
        room.peers.delete(socketId);
        logger.info(`User ${socketId} removed from room ${roomId}`);

        // Cleanup transcription session if exists
        const { transcriptionSessions } = require('./transcription.service');
        const session = transcriptionSessions.get(socketId);
        if (session) {
          session.isActive = false;
          if (session.audioStream) session.audioStream.end();
          transcriptionSessions.delete(socketId);
        }
        
        if (room.peers.size === 0) {
          logger.info(`Room ${roomId} is empty, starting cleanup timer`);
          room.cleanupTimeout = setTimeout(() => {
            if (room.peers.size === 0) {
              room.router.close();
              this.rooms.delete(roomId);
              logger.info(`Room ${roomId} cleaned up due to inactivity`);
            }
          }, 5 * 60 * 1000); // 5 minutes
        }
        break;
      }
    }
  }
}

module.exports = new RoomManager();
