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
      // Create router immediately
      const router = await this.worker.createRouter({ mediaCodecs: config.mediaCodecs });
      room = {
        id: roomId,
        router,
        peers: new Map(),
        password,
        hostId: null,
        whiteboard: { strokes: [], background: '#ffffff' },
        notes: '',
        polls: new Map(),
        chatMessages: [],
        createdAt: new Date(),
        settings: {
          video: { res: '720p', fps: 30, bitrate: 2500 },
          audio: { rate: 48000, channels: 2, echoCancellation: true }
        }
      };
      this.rooms.set(roomId, room);
      
      // Auto-cleanup room if empty after 5 minutes
      room.cleanupTimeout = null;
      
      // DEFER logging to avoid blocking room creation
      setImmediate(() => {
        logUserJoin(roomId, {
            action: 'ROOM_CREATED',
            hasPassword: !!password,
            timestamp: new Date().toISOString()
        }).catch(err => logger.error(`DynamoDB logging failed for room ${roomId}:`, err));
      });
      
      logger.info(`New room created: ${roomId}`);
    }
    return room;
  }

  async joinRoom(socket, { roomId, username, password, recorder = false }) {
    // PRE-FETCH ROOM (Non-blocking as much as possible)
    const room = await this.getOrCreateRoom(roomId, password);
    
    if (room.cleanupTimeout) {
      clearTimeout(room.cleanupTimeout);
      room.cleanupTimeout = null;
    }

    if (room.password && room.password !== password) {
      throw new Error('Invalid password');
    }

    const peerData = {
      id: socket.id,
      username: recorder ? 'System Recorder' : username,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      joinedAt: new Date(),
      isRecorder: !!recorder,
      isHost: room.hostId === null && !recorder
    };

    if (peerData.isHost) {
      room.hostId = socket.id;
    }

    room.peers.set(socket.id, peerData);

    // INSTANT SOCKET JOIN
    socket.join(roomId);

    // DEFER HEAVY SYNC (Non-blocking for the join callback)
    setImmediate(() => {
      socket.emit('sync-state', {
        whiteboard: room.whiteboard,
        notes: room.notes,
        polls: Array.from(room.polls.values())
      });

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

      logUserJoin(roomId, {
        socketId: socket.id,
        username: peerData.username,
        isRecorder: peerData.isRecorder,
        action: 'USER_JOINED'
      }).catch(err => logger.error(`User join logging failed:`, err));
    });

    return {
      rtpCapabilities: this.globalRtpCapabilities,
      isHost: peerData.isHost
    };
  }

  handleDisconnect(socketId) {
    for (const [roomId, room] of this.rooms) {
      if (room.peers.has(socketId)) {
        room.peers.delete(socketId);
        logger.info(`User ${socketId} removed from room ${roomId}`);

        // Handle Host Migration
        if (room.hostId === socketId) {
          room.hostId = null;
          if (room.peers.size > 0) {
            let oldestPeerId = null;
            let oldestJoinTime = Infinity;

            for (const [peerId, peer] of room.peers.entries()) {
              if (!peer.isRecorder && peer.joinedAt < oldestJoinTime) {
                oldestJoinTime = peer.joinedAt;
                oldestPeerId = peerId;
              }
            }
            if (oldestPeerId) {
              room.hostId = oldestPeerId;
              logger.info(`Host migrated to ${oldestPeerId} in room ${roomId}`);
            }
          }
        }

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
