const mediasoup = require('mediasoup');
const config = require('../config');
const { logUserJoin, saveRoomDetails, logUserLeave } = require('./aws.service');
const logger = require('../utils/logger');

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.workers = [];
    this.workerIdx = 0;
    this.globalRtpCapabilities = null;
    this.routerPool = [];
    this.POOL_SIZE = 10; // Increased for better production readiness
  }

  async initialize(workers) {
    this.workers = workers;
    
    // Get capabilities from first worker
    this.globalRtpCapabilities = this.workers[0].rtpCapabilities;
    
    // Fill router pool across all workers
    for (let i = 0; i < this.POOL_SIZE; i++) {
      const worker = this.getNextWorker();
      worker.createRouter({ mediaCodecs: config.mediaCodecs })
        .then(router => this.routerPool.push(router))
        .catch(err => logger.error('Router pool creation failed:', err));
    }
    
    logger.info(`RoomManager initialized with ${this.workers.length} workers and pool size ${this.POOL_SIZE}`);
  }

  getNextWorker() {
    const worker = this.workers[this.workerIdx];
    this.workerIdx = (this.workerIdx + 1) % this.workers.length;
    return worker;
  }

  async getOrCreateRoom(roomId, password = null) {
    let room = this.rooms.get(roomId);
    if (!room) {
      const router = this.routerPool.pop() || await this.getNextWorker().createRouter({ mediaCodecs: config.mediaCodecs });
      
      if (this.routerPool.length < this.POOL_SIZE) {
        this.getNextWorker().createRouter({ mediaCodecs: config.mediaCodecs })
          .then(r => this.routerPool.push(r))
          .catch(err => logger.error('Router pool refill failed:', err));
      }

      room = {
        id: roomId,
        sessionId: `SESS-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
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
      
      room.cleanupTimeout = null;
      
      setImmediate(() => {
        saveRoomDetails(roomId, room.sessionId, {
            action: 'ROOM_CREATED',
            hasPassword: !!password,
            timestamp: new Date().toISOString()
        }).catch(err => logger.error(`DynamoDB logging failed for room ${roomId}:`, err));
      });
      
      logger.info(`New room created instantly from pool: ${roomId}`);
    }
    return room;
  }

  async joinRoom(socket, { roomId, username, password, recorder = false }) {
    // START GETTING ROOM (Router creation is the bottleneck)
    const roomPromise = this.getOrCreateRoom(roomId, password);
    
    // WHILE WAITING, SETUP PEER DATA
    const peerData = {
      id: socket.id,
      username: recorder ? 'System Recorder' : username,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      joinedAt: new Date(),
      isRecorder: !!recorder
    };

    const room = await roomPromise;
    
    if (room.cleanupTimeout) {
      clearTimeout(room.cleanupTimeout);
      room.cleanupTimeout = null;
    }

    if (room.password && room.password !== password) {
      throw new Error('Invalid password');
    }

    peerData.isHost = room.hostId === null && !recorder;
    if (peerData.isHost) {
      room.hostId = socket.id;
    }

    room.peers.set(socket.id, peerData);
    socket.join(roomId);

    // BACKGROUND DATA SYNC
    setImmediate(() => {
      // 1. Sync State
      socket.emit('sync-state', {
        whiteboard: room.whiteboard,
        notes: room.notes,
        polls: room.polls ? Array.from(room.polls.values()).map(p => ({
          id: p.id, question: p.question, options: p.options.map(o => o.text),
          creatorUsername: p.creatorUsername, isAnonymous: p.isAnonymous,
          allowMultiple: p.allowMultiple, createdAt: p.createdAt,
          results: p.options.map(o => o.votes), active: p.active
        })) : [],
        chatMessages: room.chatMessages || []
      });

      // 2. Sync Producers
      const activeProducers = [];
      for (const [peerId, peer] of room.peers.entries()) {
        if (peerId !== socket.id) {
          for (const [producerId, producer] of peer.producers.entries()) {
            activeProducers.push({
              socketId: peerId,
              producerId: producerId,
              kind: producer.kind,
              appData: producer.appData
            });
          }
        }
      }
      if (activeProducers.length > 0) {
        socket.emit('active-producers', activeProducers);
      }

      // 3. Log Join
      logUserJoin(roomId, room.sessionId, {
        socketId: socket.id,
        username: peerData.username,
        isRecorder: peerData.isRecorder,
        action: 'USER_JOINED'
      }).catch(() => {});
    });

    return {
      rtpCapabilities: this.globalRtpCapabilities,
      isHost: peerData.isHost
    };
  }

  handleDisconnect(socketId) {
    for (const [roomId, room] of this.rooms) {
      if (room.peers.has(socketId)) {
        const peer = room.peers.get(socketId);
        room.peers.delete(socketId);
        logger.info(`User ${socketId} removed from room ${roomId}`);

        // Log Leave to DynamoDB
        logUserLeave(roomId, room.sessionId, {
          socketId: socketId,
          username: peer.username,
          joinedAt: peer.joinedAt,
          duration: Date.now() - new Date(peer.joinedAt).getTime()
        }).catch(() => {});

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
          
          // Auto-stop recording if in progress
          const { stopRecording, recordingSessions } = require('./recording.service');
          if (recordingSessions.has(roomId)) {
            logger.info(`[Recording] Auto-stopping recording for empty room ${roomId}`);
            stopRecording(roomId).then(async (result) => {
              logger.info(`[Recording] Auto-stop and upload successful for room ${roomId}: ${result.recordingId}`);
              
              // Save full transcription JSON to DynamoDB at end of session
              if (result.metadata && result.metadata.transcripts && result.metadata.transcripts.length > 0) {
                const { saveTranscription } = require('./aws.service');
                await saveTranscription(roomId, room.sessionId, {
                  type: 'FULL_SESSION_TRANSCRIPT',
                  transcripts: result.metadata.transcripts
                }).catch(err => logger.error('[AWS] Full transcription save failed:', err));
              }
            }).catch(err => logger.error(`Auto-stop recording failed for room ${roomId}:`, err));
          }

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
