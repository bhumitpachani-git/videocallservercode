const mediasoup = require('mediasoup');
const config = require('../config');
const { 
  logUserJoin, 
  saveRoomDetails, 
  logUserLeave, 
  closeSession, 
  saveChatTranscript, 
  savePollData,
  saveNotesData,
  saveFullTranscription,
  saveSessionEvent
} = require('./aws.service');
const logger = require('../utils/logger');

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.workers = [];
    this.workerIdx = 0;
    this.globalRtpCapabilities = null;
    this.routerPool = [];
    this.POOL_SIZE = 10;
    this.participantHistory = new Map();
  }

  async initialize(workers) {
    this.workers = workers;
    
    const tempRouter = await this.workers[0].createRouter({ mediaCodecs: config.mediaCodecs });
    this.globalRtpCapabilities = tempRouter.rtpCapabilities;
    tempRouter.close();
    
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
        sessionNumber: 1,
        router,
        peers: new Map(),
        password,
        hostId: null,
        whiteboard: { strokes: [], background: '#ffffff' },
        notes: '',
        polls: new Map(),
        chatMessages: [],
        createdAt: new Date(),
        sessionStartedAt: new Date(),
        participantHistory: [],
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
            sessionNumber: room.sessionNumber,
            hasPassword: !!password,
            timestamp: new Date().toISOString()
        }).catch(err => logger.error(`DynamoDB logging failed for room ${roomId}:`, err));
      });
      
      logger.info(`New room created with session ${room.sessionId}: ${roomId}`);
    }
    return room;
  }

  async startNewSession(room) {
    const newSessionId = `SESS-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newSessionNumber = (room.sessionNumber || 1) + 1;
    
    logger.info(`Starting new session ${newSessionId} (session #${newSessionNumber}) for room ${room.id}`);
    
    room.sessionId = newSessionId;
    room.sessionNumber = newSessionNumber;
    room.sessionStartedAt = new Date();
    room.chatMessages = [];
    room.polls = new Map();
    room.notes = '';
    room.whiteboard = { strokes: [], background: '#ffffff' };
    room.participantHistory = [];
    
    setImmediate(() => {
      saveRoomDetails(room.id, room.sessionId, {
        action: 'SESSION_STARTED',
        sessionNumber: newSessionNumber,
        timestamp: new Date().toISOString()
      }).catch(err => logger.error(`New session logging failed for room ${room.id}:`, err));
    });
    
    return newSessionId;
  }

  async closeCurrentSession(room) {
    if (!room || !room.sessionId) return;
    
    logger.info(`Closing session ${room.sessionId} for room ${room.id}`);
    
    const sessionDuration = Date.now() - new Date(room.sessionStartedAt).getTime();
    
    try {
      if (room.chatMessages && room.chatMessages.length > 0) {
        await saveChatTranscript(room.id, room.sessionId, room.chatMessages);
      }
      
      if (room.notes && room.notes.length > 0) {
        await saveNotesData(room.id, room.sessionId, room.notes);
      }
      
      if (room.polls && room.polls.size > 0) {
        for (const [pollId, poll] of room.polls.entries()) {
          const totalVotes = Array.from(poll.votes.values()).reduce((sum, arr) => sum + arr.length, 0);
          await savePollData(room.id, room.sessionId, {
            id: pollId,
            question: poll.question,
            options: poll.options.map(o => o.text),
            results: poll.options.map(o => o.votes),
            totalVotes,
            creatorUsername: poll.creatorUsername,
            isAnonymous: poll.isAnonymous,
            allowMultiple: poll.allowMultiple,
            active: poll.active,
            action: 'SESSION_FINAL',
            createdAt: poll.createdAt
          });
        }
      }
      
      await closeSession(room.id, room.sessionId, {
        startedAt: room.sessionStartedAt,
        duration: sessionDuration,
        totalParticipants: room.participantHistory?.length || 0,
        totalMessages: room.chatMessages?.length || 0,
        totalPolls: room.polls?.size || 0,
        hasNotes: !!(room.notes && room.notes.length > 0),
        hasWhiteboard: !!(room.whiteboard?.strokes?.length > 0),
        hasTranscript: false,
        participants: room.participantHistory || []
      });
      
      logger.info(`Session ${room.sessionId} closed successfully for room ${room.id}`);
    } catch (error) {
      logger.error(`Error closing session ${room.sessionId}:`, error);
    }
  }

  async joinRoom(socket, { roomId, username, password, recorder = false }) {
    const roomPromise = this.getOrCreateRoom(roomId, password);
    
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

    if (room.peers.size === 0 && room.sessionId) {
      await this.startNewSession(room);
    }

    peerData.isHost = room.hostId === null && !recorder;
    if (peerData.isHost) {
      room.hostId = socket.id;
    }

    room.peers.set(socket.id, peerData);
    socket.join(roomId);

    if (!room.participantHistory) room.participantHistory = [];
    room.participantHistory.push({
      socketId: socket.id,
      username: peerData.username,
      joinedAt: peerData.joinedAt,
      isHost: peerData.isHost
    });

    setImmediate(() => {
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

        const participantIdx = room.participantHistory?.findIndex(p => p.socketId === socketId);
        if (participantIdx !== -1 && room.participantHistory[participantIdx]) {
          room.participantHistory[participantIdx].leftAt = new Date();
          room.participantHistory[participantIdx].duration = Date.now() - new Date(peer.joinedAt).getTime();
        }

        logUserLeave(roomId, room.sessionId, {
          socketId: socketId,
          username: peer.username,
          joinedAt: peer.joinedAt,
          duration: Date.now() - new Date(peer.joinedAt).getTime()
        }).catch(() => {});

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

        const { transcriptionSessions } = require('./transcription.service');
        const session = transcriptionSessions.get(socketId);
        if (session) {
          session.isActive = false;
          if (session.audioStream) session.audioStream.end();
          
          if (session.fullTranscript) {
            saveFullTranscription(roomId, room.sessionId, session.fullTranscript)
              .catch(err => logger.error('[AWS] Full transcription save failed:', err));
          }
          
          transcriptionSessions.delete(socketId);
        }
        
        if (room.peers.size === 0) {
          logger.info(`Room ${roomId} is empty - IMMEDIATELY saving all session data to DynamoDB`);
          
          const { stopRecording, recordingSessions } = require('./recording.service');
          
          (async () => {
            try {
              if (recordingSessions.has(roomId)) {
                logger.info(`[Recording] Auto-stopping recording for empty room ${roomId}`);
                const result = await stopRecording(roomId);
                logger.info(`[Recording] Auto-stop and upload successful for room ${roomId}: ${result.recordingId}`);
                
                if (result.metadata && result.metadata.transcripts && result.metadata.transcripts.length > 0) {
                  const { saveTranscription } = require('./aws.service');
                  await saveTranscription(roomId, room.sessionId, {
                    type: 'FULL_SESSION_TRANSCRIPT',
                    transcripts: result.metadata.transcripts
                  });
                }
              }

              await this.closeCurrentSession(room);
              logger.info(`Session ${room.sessionId} data SAVED IMMEDIATELY for room ${roomId}`);
              
            } catch (err) {
              logger.error(`Error during immediate session save for room ${roomId}:`, err);
            }
          })();

          room.cleanupTimeout = setTimeout(() => {
            if (room.peers.size === 0) {
              room.router.close();
              this.rooms.delete(roomId);
              logger.info(`Room ${roomId} cleaned up from memory after 5 minutes`);
            }
          }, 5 * 60 * 1000);
        }
        break;
      }
    }
  }
}

module.exports = new RoomManager();
