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
        if (room.peers.size === 0) {
          // Optional: Cleanup room after some timeout
        }
        break;
      }
    }
  }
}

module.exports = new RoomManager();
