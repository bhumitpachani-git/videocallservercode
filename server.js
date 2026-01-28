require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { TranslateClient, TranslateTextCommand } = require('@aws-sdk/client-translate');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { 
  recordingSessions, 
  startRecording, 
  stopRecording,
  startRecordingForPeer 
} = require('./recording-service');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const LANGUAGE_CODE_MAP = {
  'auto': 'auto',
  'en': 'en-US',
  'es': 'es-US',
  'fr': 'fr-FR',
  'de': 'de-DE',
  'it': 'it-IT',
  'pt': 'pt-BR',
  'zh': 'zh-CN',
  'ja': 'ja-JP',
  'ko': 'ko-KR',
  'ar': 'ar-SA',
  'hi': 'hi-IN',
  'ru': 'ru-RU',
};

const AWS_TO_SHORT_CODE = {
  'en-US': 'en',
  'es-US': 'es',
  'fr-FR': 'fr',
  'de-DE': 'de',
  'it-IT': 'it',
  'pt-BR': 'pt',
  'zh-CN': 'zh',
  'ja-JP': 'ja',
  'ko-KR': 'ko',
  'ar-SA': 'ar',
  'hi-IN': 'hi',
  'ru-RU': 'ru',
};

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      'sprop-stereo': 1,
      'usedtx': 1,
      'maxaveragebitrate': 128000
    }
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 800
    }
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 800
    }
  }
];

const webRtcTransportOptions = {
  listenIps: [
    {
      ip: "0.0.0.0",
      announcedIp: process.env.ANNOUNCED_IP || "192.168.1.6"
    }
  ],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
};

const plainTransportOptions = {
  listenIp: { ip: '127.0.0.1', announcedIp: null },
  rtcpMux: false,
  comedia: true
};

// ============================================================================
// AWS CLIENTS
// ============================================================================

const transcribeClient = new TranscribeStreamingClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const translateClient = new TranslateClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ============================================================================
// EXPRESS & SOCKET.IO SETUP
// ============================================================================

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// ============================================================================
// GLOBAL STATE
// ============================================================================

let worker;
const rooms = new Map();
const transcriptionSessions = new Map();
// const recordingSessions = new Map();

// ============================================================================
// MEDIASOUP WORKER
// ============================================================================

async function createWorker() {
  try {
    worker = await mediasoup.createWorker({
      logLevel: 'warn',
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
    });

    console.log(`[MediaSoup] Worker created with PID: ${worker.pid}`);

    worker.on('died', () => {
      console.error('[MediaSoup] Worker died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });

    return worker;
  } catch (error) {
    console.error('[MediaSoup] Failed to create worker:', error);
    throw error;
  }
}

// ============================================================================
// ROOM MANAGEMENT
// ============================================================================

async function getOrCreateRoom(roomId, password = null) {
  if (!rooms.has(roomId)) {
    const router = await worker.createRouter({ mediaCodecs });
    rooms.set(roomId, {
      router,
      peers: new Map(),
      password: password,
      hostId: null,
      polls: new Map(),
      whiteboard: { strokes: [], background: '#ffffff' },
      notes: ''
    });
    console.log(`[Room] Created: ${roomId}`);
  }
  return rooms.get(roomId);
}

function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    room.router.close();
    rooms.delete(roomId);
    console.log(`[Room] Deleted: ${roomId}`);
  }
}

// ============================================================================
// TRANSLATION SERVICE
// ============================================================================

async function translateText(text, sourceLanguage, targetLanguage) {
  if (sourceLanguage === targetLanguage || !text || text.trim() === '') {
    return text;
  }

  try {
    const command = new TranslateTextCommand({
      Text: text,
      SourceLanguageCode: sourceLanguage,
      TargetLanguageCode: targetLanguage,
    });

    const response = await translateClient.send(command);
    return response.TranslatedText || text;
  } catch (error) {
    console.error('[Translation] Error:', {
      source: sourceLanguage,
      target: targetLanguage,
      error: error.message
    });
    return text;
  }
}

// ============================================================================
// RECORDING SERVICE - FIXED IMPLEMENTATION
// ============================================================================

async function createRecordingConsumer(room, producer, plainTransport) {
  try {
    const consumer = await plainTransport.consume({
      producerId: producer.id,
      rtpCapabilities: room.router.rtpCapabilities,
      paused: false
    });

    console.log(`[Recording] Created consumer for ${producer.kind} producer ${producer.id}`);
    return consumer;
  } catch (error) {
    console.error(`[Recording] Failed to create consumer:`, error);
    throw error;
  }
}

// ============================================================================
// TRANSCRIPTION SERVICE
// ============================================================================

async function handleTranscription(socket, { roomId, username, targetLanguage = 'en', speakingLanguage = 'auto' }) {
  console.log(`[Transcription] Starting for ${username} in room ${roomId}, speaking: ${speakingLanguage}, target: ${targetLanguage}`);

  if (!rooms.has(roomId)) {
    socket.emit('transcription-error', { error: 'Room not found' });
    return;
  }

  const audioStream = new PassThrough();

  transcriptionSessions.set(socket.id, {
    socketId: socket.id,
    roomId,
    username,
    targetLanguage,
    speakingLanguage,
    audioStream,
    isActive: true,
  });

  try {
    const transcribeParams = {
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 16000,
      AudioStream: (async function* () {
        for await (const chunk of audioStream) {
          if (transcriptionSessions.get(socket.id)?.isActive) {
            yield { AudioEvent: { AudioChunk: chunk } };
          }
        }
      })(),
    };

    if (speakingLanguage === 'auto') {
      transcribeParams.IdentifyLanguage = true;
      transcribeParams.LanguageOptions = 'en-US,es-US,fr-FR,de-DE,it-IT,pt-BR,zh-CN,ja-JP,ko-KR,ar-SA,hi-IN,ru-RU';
    } else {
      const awsLanguageCode = LANGUAGE_CODE_MAP[speakingLanguage] || 'en-US';
      transcribeParams.LanguageCode = awsLanguageCode;
      console.log(`[Transcription] Using specific language code: ${awsLanguageCode} for ${username}`);
    }

    const command = new StartStreamTranscriptionCommand(transcribeParams);
    const response = await transcribeClient.send(command);

    for await (const event of response.TranscriptResultStream) {
      const session = transcriptionSessions.get(socket.id);
      if (!session || !session.isActive) break;

      if (!event.TranscriptEvent) continue;

      const results = event.TranscriptEvent.Transcript.Results || [];

      for (const result of results) {
        if (!result.Alternatives?.length) continue;

        const transcript = result.Alternatives[0].Transcript;
        const isFinal = !result.IsPartial;

        const detectedLanguageCode = result.LanguageCode || 'en-US';
        const detectedLanguage = AWS_TO_SHORT_CODE[detectedLanguageCode] || 'en';

        if (!transcript || transcript.trim() === '') continue;

        console.log(`[Transcription] ${username} (${detectedLanguage}): "${transcript}"`);

        const room = rooms.get(roomId);
        if (!room) continue;

        const speakerSession = transcriptionSessions.get(socket.id);
        const actualLanguage = speakerSession?.speakingLanguage && speakerSession.speakingLanguage !== 'auto'
          ? speakerSession.speakingLanguage
          : detectedLanguage;

        console.log(`[Transcription] ${username} speaking ${actualLanguage}: "${transcript}"`);

        // Send to each peer with their own translation
        for (const [peerId, peer] of room.peers.entries()) {
          const peerSession = transcriptionSessions.get(peerId);
          const peerTargetLang = peerSession?.targetLanguage || 'en';

          let translatedText = transcript;
          let shouldTranslate = false;

          if (peerId !== socket.id && peerTargetLang !== 'auto' && peerTargetLang !== actualLanguage) {
            shouldTranslate = true;
            try {
              translatedText = await translateText(
                transcript,
                actualLanguage,
                peerTargetLang
              );
              console.log(`[Translation] ${actualLanguage} → ${peerTargetLang} for ${peer.username}: "${translatedText}"`);
            } catch (error) {
              console.error('[Translation] Error:', error);
              translatedText = transcript;
              shouldTranslate = false;
            }
          }

          const transcriptionPayload = {
            id: `${socket.id}-${Date.now()}-${Math.random()}`,
            socketId: socket.id,
            username,
            originalText: transcript,
            translatedText: shouldTranslate && translatedText !== transcript ? translatedText : undefined,
            originalLanguage: actualLanguage,
            targetLanguage: peerTargetLang,
            isFinal,
            timestamp: new Date().toISOString(),
          };

          const recordingSession = recordingSessions.get(roomId);
          if (recordingSession && isFinal && peerId === socket.id) {
            recordingSession.transcripts.push({
              ...transcriptionPayload,
              translatedText: undefined,
            });
          }

          io.to(peerId).emit('transcription', transcriptionPayload);
        }
      }
    }
  } catch (error) {
    console.error('[Transcription] Error:', error);
    socket.emit('transcription-error', {
      error: error.message || 'Transcription failed',
    });
  } finally {
    const session = transcriptionSessions.get(socket.id);
    if (session) {
      session.isActive = false;
    }
  }
}

// ============================================================================
// HOST MIGRATION
// ============================================================================

function migrateHost(room, roomId, currentHostId) {
  room.hostId = null;

  if (room.peers.size === 0) {
    return;
  }

  let oldestPeerId = null;
  let oldestJoinTime = Infinity;

  for (const [peerId, peer] of room.peers.entries()) {
    if (peer.joinedAt < oldestJoinTime) {
      oldestJoinTime = peer.joinedAt;
      oldestPeerId = peerId;
    }
  }

  if (oldestPeerId) {
    room.hostId = oldestPeerId;
    const nextHost = room.peers.get(oldestPeerId);
    nextHost.isHost = true;

    io.to(roomId).emit('host-changed', {
      newHostId: oldestPeerId,
      username: nextHost.username
    });

    console.log(`[Host] Migrated to ${nextHost.username} (${oldestPeerId}) - oldest participant`);
  }
}

// ============================================================================
// SOCKET.IO EVENT HANDLERS
// ============================================================================

io.on('connection', (socket) => {
  console.log(`[Connection] Client connected: ${socket.id}`);

  let currentRoomId = null;
  let currentUsername = null;

  // ========================================
  // ROOM EVENTS
  // ========================================

  socket.on('join-room', async ({ roomId, username, password }, callback) => {
    try {
      let room = rooms.get(roomId);

      // Check password if room exists and has password
      if (room && room.password && room.password !== password) {
        return callback({ error: 'Invalid password' });
      }

      // Create room if it doesn't exist
      if (!room) {
        room = await getOrCreateRoom(roomId, password);
      }

      currentRoomId = roomId;
      currentUsername = username;

      if (!room.hostId) {
        room.hostId = socket.id;
        console.log(`[Room] User ${username} (${socket.id}) is now host of room ${roomId}`);
      }
      const isUserHost = room.hostId === socket.id;

      // Add peer to room
      room.peers.set(socket.id, {
        username,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        isHost: isUserHost,
        joinedAt: Date.now()
      });

      socket.join(roomId);

      const rtpCapabilities = room.router.rtpCapabilities;

      // Get existing peers
      const existingPeers = [];
      room.peers.forEach((peer, peerId) => {
        if (peerId !== socket.id) {
          existingPeers.push({
            socketId: peerId,
            username: peer.username,
            isHost: peerId === room.hostId
          });
        }
      });

      // Get polls
      const pollsArray = room.polls ? Array.from(room.polls.values()).map(p => ({
        id: p.id,
        question: p.question,
        options: p.options.map(o => o.text),
        creatorUsername: p.creatorUsername,
        isAnonymous: p.isAnonymous,
        allowMultiple: p.allowMultiple,
        createdAt: p.createdAt,
        results: p.options.map(o => o.votes),
        totalVotes: Array.from(p.votes.values()).reduce((sum, arr) => sum + arr.length, 0),
        active: p.active
      })) : [];

      // Check if recording is active
      const isRecording = recordingSessions.has(roomId);

      // Send response to joining user
      callback({
        rtpCapabilities,
        peers: existingPeers,
        whiteboard: room.whiteboard,
        notes: room.notes,
        polls: pollsArray,
        isHost: isUserHost,
        isRecording
      });

      // Notify other users
      socket.to(roomId).emit('user-joined', {
        socketId: socket.id,
        username,
        isHost: isUserHost
      });

      // If recording is active, start recording for this new peer
      if (isRecording) {
        const recordingSession = recordingSessions.get(roomId);
        // Wait a bit for media setup
        setTimeout(async () => {
          await startRecordingForPeer(roomId, socket.id, room.peers.get(socket.id), recordingSession);
        }, 3000);
      }

      console.log(`[Room] User ${username} joined room ${roomId}`);
    } catch (error) {
      console.error('[Room] Error joining room:', error);
      callback({ error: error.message });
    }
  });

  // ========================================
  // HOST CONTROLS
  // ========================================

  socket.on('mute-participant', ({ roomId, targetSocketId, kind }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) throw new Error('Room not found');
      if (room.hostId !== socket.id) throw new Error('Only host can mute participants');

      io.to(targetSocketId).emit('force-mute', { kind });
      callback({ success: true });

      console.log(`[Host] ${currentUsername} muted ${kind} for ${targetSocketId}`);
    } catch (error) {
      console.error('[Host] Error muting participant:', error);
      callback({ error: error.message });
    }
  });

  // ========================================
  // RECORDING EVENTS - FIXED
  // ========================================

  socket.on('start-recording', async ({ roomId, username }, callback) => {
    console.log(`[Recording] Start request for room ${roomId} by ${username}`);

    try {
      const room = rooms.get(roomId);
      if (!room) {
        const error = 'Room not found';
        socket.emit('recording-error', { error });
        if (callback) callback({ error });
        return;
      }

      // Check if already recording
      if (recordingSessions.has(roomId)) {
        const error = 'Recording already in progress';
        socket.emit('recording-error', { error });
        if (callback) callback({ error });
        return;
      }

    const recordingSession = await startRecording(roomId, username, io, rooms);

      const response = {
        success: true,
        recordingId: recordingSession.recordingId,
        startedBy: username,
        startedAt: recordingSession.startedAt,
      };

      // Notify all participants
      io.to(roomId).emit('recording-started', response);
      
      if (callback) callback(response);

      console.log(`[Recording] ✓ Started successfully for room ${roomId}`);
    } catch (error) {
      console.error('[Recording] Error starting recording:', error);
      const errorMsg = error.message || 'Failed to start recording';
      socket.emit('recording-error', { error: errorMsg });
      if (callback) callback({ error: errorMsg });
    }
  });

  socket.on('stop-recording', async ({ roomId }, callback) => {
    console.log(`[Recording] Stop request for room ${roomId}`);

    try {
      const result = await stopRecording(roomId);

      const response = {
      success: true,
      recordingId: result.recordingId,
      downloadPath: `/api/recordings/${roomId}/${result.recordingId}-metadata.json`,
      files: result.files.map(f => ({
        username: f.username,
        file: f.file,
        size: f.size,
        duration: f.duration,
        downloadPath: `/api/recordings/${roomId}/${f.file}`
      }))
    };

      // Notify all participants
      io.to(roomId).emit('recording-stopped', response);
      
      if (callback) callback(response);

      console.log(`[Recording] ✓ Stopped successfully for room ${roomId}`);
    } catch (error) {
      console.error('[Recording] Error stopping recording:', error);
      const errorMsg = error.message || 'Failed to stop recording';
      socket.emit('recording-error', { error: errorMsg });
      if (callback) callback({ error: errorMsg });
    }
  });

  // ========================================
  // TRANSCRIPTION EVENTS
  // ========================================

  socket.on('start-transcription', async (data) => {
    await handleTranscription(socket, data);
  });

  socket.on('audio-chunk', ({ roomId, username, audioData }) => {
    const session = transcriptionSessions.get(socket.id);
    if (session && session.audioStream && session.isActive) {
      try {
        const buffer = Buffer.from(new Int16Array(audioData).buffer);
        session.audioStream.write(buffer);
      } catch (error) {
        console.error('[Audio Chunk] Error writing to stream:', error);
      }
    }
  });

  socket.on('stop-transcription', ({ roomId }) => {
    const session = transcriptionSessions.get(socket.id);
    if (session) {
      session.isActive = false;
      if (session.audioStream) {
        session.audioStream.end();
      }
      transcriptionSessions.delete(socket.id);
      console.log(`[Transcription] Stopped for socket ${socket.id}`);
    }
  });

  socket.on('set-target-language', ({ roomId, targetLanguage }) => {
    const session = transcriptionSessions.get(socket.id);
    if (session) {
      session.targetLanguage = targetLanguage;
      console.log(`[Transcription] Target language set to ${targetLanguage} for socket ${socket.id}`);
    }
  });

  // ========================================
  // WEBRTC TRANSPORT EVENTS
  // ========================================

  socket.on('create-transport', async ({ roomId, direction }, callback) => {
    try {
      const room = rooms.get(roomId);
      if (!room) throw new Error('Room not found');

      const transport = await room.router.createWebRtcTransport(webRtcTransportOptions);

      const peer = room.peers.get(socket.id);
      peer.transports.set(transport.id, transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });

      console.log(`[Transport] Created: ${transport.id} for ${direction}`);
    } catch (error) {
      console.error('[Transport] Error creating transport:', error);
      callback({ error: error.message });
    }
  });

  socket.on('connect-transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
    try {
      const room = rooms.get(roomId);
      const peer = room.peers.get(socket.id);
      const transport = peer.transports.get(transportId);

      await transport.connect({ dtlsParameters });
      callback({ success: true });

      console.log(`[Transport] Connected: ${transportId}`);
    } catch (error) {
      console.error('[Transport] Error connecting transport:', error);
      callback({ error: error.message });
    }
  });

  // ========================================
  // PRODUCER/CONSUMER EVENTS
  // ========================================

  socket.on('produce', async ({ roomId, transportId, kind, rtpParameters }, callback) => {
    try {
      console.log(`\n[Producer] ====== PRODUCE REQUEST ======`);
      console.log(`[Producer] Room: ${roomId}, Transport: ${transportId}, Kind: ${kind}`);
      
      const room = rooms.get(roomId);
      if (!room) throw new Error(`Room not found: ${roomId}`);
      
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error(`Peer not found: ${socket.id}`);
      
      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error(`Transport not found: ${transportId}`);

      console.log(`[Producer] 🏗️  Creating producer...`);
      const producer = await transport.produce({ kind, rtpParameters });
      peer.producers.set(producer.id, producer);

      console.log(`[Producer] ✅ Producer created: ${producer.id}`);
      
      // If recording is active, start recording for this producer
      const recordingSession = recordingSessions.get(roomId);
      if (recordingSession && !recordingSession.participants.has(socket.id)) {
        console.log(`[Recording] 📹 New producer during recording, starting recording for ${peer.username}`);
        setTimeout(async () => {
          await startRecordingForPeer(roomId, socket.id, peer, recordingSession, rooms);
        }, 2000); // 2 second delay for stream to stabilize
      }
      
      console.log(`[Producer] 📤 Broadcasting to ${room.peers.size - 1} other peers...`);
      socket.to(roomId).emit('new-producer', {
        socketId: socket.id,
        producerId: producer.id,
        kind
      });

      callback({ id: producer.id });
      console.log(`[Producer] ====== PRODUCE SUCCESS ======\n`);
    } catch (error) {
      console.error('[Producer] Error producing:', error.message);
      callback({ error: error.message });
    }
  });

  socket.on('consume', async ({ roomId, transportId, producerId, rtpCapabilities }, callback) => {
    try {
      console.log(`\n[Consumer] ====== CONSUME REQUEST ======`);
      console.log(`[Consumer] Room: ${roomId}, Transport: ${transportId}, Producer: ${producerId}`);
      
      const room = rooms.get(roomId);
      if (!room) {
        throw new Error(`Room not found: ${roomId}`);
      }
      console.log(`[Consumer] ✅ Room found`);
      
      const peer = room.peers.get(socket.id);
      if (!peer) {
        throw new Error(`Peer not found: ${socket.id}`);
      }
      console.log(`[Consumer] ✅ Peer found`);
      
      const transport = peer.transports.get(transportId);
      if (!transport) {
        throw new Error(`Transport not found: ${transportId}`);
      }
      console.log(`[Consumer] ✅ Transport found`);

      let producer = null;
      for (const [peerId, p] of room.peers.entries()) {
        if (p.producers.has(producerId)) {
          producer = p.producers.get(producerId);
          console.log(`[Consumer] ✅ Producer found in peer ${peerId}`);
          break;
        }
      }

      if (!producer) {
        throw new Error(`Producer not found: ${producerId}`);
      }

      console.log(`[Consumer] 🔍 Checking if can consume...`);
      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume - router compatibility check failed');
      }
      console.log(`[Consumer] ✅ Can consume`);

      console.log(`[Consumer] 🏗️  Creating consumer...`);
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true
      });

      peer.consumers.set(consumer.id, consumer);
      
      console.log(`[Consumer] ✅ Consumer created successfully`);
      console.log(`[Consumer] Consumer details:`, {
        consumerId: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        paused: consumer.paused
      });

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });

      console.log(`[Consumer] ====== CONSUME SUCCESS ======\n`);
    } catch (error) {
      console.error(`[Consumer] ❌ Error consuming:`, error.message);
      console.error(`[Consumer] Stack:`, error.stack);
      callback({ error: error.message });
    }
  });

  socket.on('resume-consumer', async ({ roomId, consumerId }, callback) => {
    try {
      console.log(`\n[Consumer] ====== RESUME REQUEST ======`);
      console.log(`[Consumer] Room: ${roomId}, Consumer: ${consumerId}`);
      
      const room = rooms.get(roomId);
      if (!room) throw new Error(`Room not found: ${roomId}`);
      
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error(`Peer not found: ${socket.id}`);
      
      const consumer = peer.consumers.get(consumerId);
      if (!consumer) throw new Error(`Consumer not found: ${consumerId}`);

      console.log(`[Consumer] ▶️  Resuming consumer...`);
      await consumer.resume();
      
      console.log(`[Consumer] ✅ Consumer resumed successfully`);
      callback({ success: true });
      console.log(`[Consumer] ====== RESUME SUCCESS ======\n`);
    } catch (error) {
      console.error('[Consumer] ❌ Error resuming consumer:', error.message);
      callback({ error: error.message });
    }

  });

  socket.on('get-producers', async ({ roomId }, callback) => {
    try {
      const room = rooms.get(roomId);
      const producers = [];

      room.peers.forEach((peer, peerId) => {
        if (peerId !== socket.id) {
          peer.producers.forEach((producer) => {
            producers.push({
              socketId: peerId,
              producerId: producer.id,
              kind: producer.kind
            });
          });
        }
      });

      callback({ producers });
    } catch (error) {
      console.error('[Producer] Error getting producers:', error);
      callback({ error: error.message });
    }
  });

  // ========================================
  // SCREEN SHARE EVENTS
  // ========================================

  socket.on('mark-screen-share', ({ roomId, producerId }) => {
    socket.to(roomId).emit('new-producer', {
      socketId: socket.id,
      producerId,
      kind: 'video',
      isScreenShare: true
    });
  });

  socket.on('screen-share-stopped', ({ roomId, producerId }) => {
    socket.to(roomId).emit('screen-share-stopped', {
      socketId: socket.id,
      producerId
    });
  });

  // ========================================
  // CHAT EVENTS
  // ========================================

  socket.on('chat-message', ({ roomId, ...message }) => {
    socket.to(roomId).emit('chat-message', message);
  });

  socket.on('send-chat-message', ({ roomId, message, toSocketId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;

      const peer = room.peers.get(socket.id);
      if (!peer) return;

      const chatMsg = {
        id: Math.random().toString(36).substr(2, 9),
        socketId: socket.id,
        username: peer.username,
        message,
        timestamp: Date.now(),
        toSocketId
      };

      if (toSocketId) {
        // Private message
        io.to(toSocketId).emit('chat-message', chatMsg);
        socket.emit('chat-message', chatMsg);
      } else {
        // Public message
        io.to(roomId).emit('chat-message', chatMsg);
      }
    } catch (error) {
      console.error('[Chat] Error sending message:', error);
    }
  });

  // ========================================
  // PEER TRACK STATUS EVENTS
  // ========================================

  socket.on('peer-track-status', ({ roomId, kind, enabled }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) return;

      // Broadcast peer mute/unmute status to all participants
      io.to(roomId).emit('peer-track-status', {
        socketId: socket.id,
        kind,
        enabled
      });

      console.log(`[Track Status] ${currentUsername || 'User'} (${socket.id}) ${kind} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      console.error('[Track Status] Error broadcasting track status:', error);
    }
  });

  // ========================================
  // POLL EVENTS
  // ========================================

  socket.on('create-poll', ({ roomId, question, options, isAnonymous = false, allowMultiple = false }) => {
    try {
      const room = rooms.get(roomId);
      if (!room) {
        return socket.emit('poll-error', { error: 'Room not found' });
      }

      const pollId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const poll = {
        id: pollId,
        question,
        options: options.map(opt => ({ text: opt, votes: 0 })),
        creator: socket.id,
        creatorUsername: currentUsername,
        isAnonymous,
        allowMultiple,
        createdAt: new Date().toISOString(),
        votes: new Map(),
        active: true
      };

      if (!room.polls) room.polls = new Map();
      room.polls.set(pollId, poll);

      io.to(roomId).emit('new-poll', {
        id: pollId,
        question,
        options: poll.options.map(o => o.text),
        creatorUsername: currentUsername,
        isAnonymous,
        allowMultiple,
        createdAt: poll.createdAt
      });

      console.log(`[Poll] Created in ${roomId}: ${question}`);
    } catch (error) {
      console.error('[Poll] Error creating poll:', error);
      socket.emit('poll-error', { error: error.message });
    }
  });

  socket.on('submit-vote', ({ roomId, pollId, selectedOptions }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !room.polls?.has(pollId)) {
        return socket.emit('poll-error', { error: 'Poll not found' });
      }

      const poll = room.polls.get(pollId);
      if (!poll.active) {
        return socket.emit('poll-error', { error: 'Poll is closed' });
      }

      if (!Array.isArray(selectedOptions) || selectedOptions.length === 0) {
        return socket.emit('poll-error', { error: 'Invalid vote' });
      }

      if (!poll.allowMultiple && selectedOptions.length > 1) {
        return socket.emit('poll-error', { error: 'Multiple votes not allowed' });
      }

      // Remove previous vote if any
      if (poll.votes.has(socket.id)) {
        const prev = poll.votes.get(socket.id);
        prev.forEach(idx => poll.options[idx].votes--);
      }

      // Apply new vote
      selectedOptions.forEach(idx => {
        if (idx >= 0 && idx < poll.options.length) {
          poll.options[idx].votes++;
        }
      });

      poll.votes.set(socket.id, selectedOptions);

      io.to(roomId).emit('poll-updated', {
        pollId,
        results: poll.options.map(o => o.votes),
        totalVotes: Array.from(poll.votes.values()).reduce((sum, arr) => sum + arr.length, 0)
      });

      socket.emit('vote-received', { pollId });
    } catch (error) {
      console.error('[Poll] Error submitting vote:', error);
      socket.emit('poll-error', { error: error.message });
    }
  });

  socket.on('close-poll', ({ roomId, pollId }) => {
    try {
      const room = rooms.get(roomId);
      if (!room || !room.polls?.has(pollId)) return;

      const poll = room.polls.get(pollId);
      if (poll.creator !== socket.id) {
        return socket.emit('poll-error', { error: 'Only creator can close poll' });
      }

      poll.active = false;

      io.to(roomId).emit('poll-closed', {
        pollId,
        finalResults: poll.options.map(o => o.votes),
        totalVotes: Array.from(poll.votes.values()).reduce((sum, arr) => sum + arr.length, 0)
      });

      console.log(`[Poll] Closed in ${roomId}: ${poll.question}`);
    } catch (error) {
      console.error('[Poll] Error closing poll:', error);
    }
  });

  // ========================================
  // WHITEBOARD EVENTS
  // ========================================

  socket.on('whiteboard-clear', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.whiteboard.strokes = [];
    io.to(roomId).emit('whiteboard-cleared');
  });

  socket.on('whiteboard-draw', ({ roomId, stroke }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.whiteboard.strokes.push(stroke);
    socket.to(roomId).emit('whiteboard-draw', stroke);
  });

  socket.on('whiteboard-undo', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.whiteboard.strokes.length === 0) return;

    room.whiteboard.strokes.pop();
    io.to(roomId).emit('whiteboard-undo');
  });

  socket.on('whiteboard-present', ({ roomId, isPresenting }) => {
    io.to(roomId).emit('whiteboard-present', {
      socketId: socket.id,
      username: currentUsername,
      isPresenting
    });
    console.log(`[Whiteboard] ${currentUsername} ${isPresenting ? 'started' : 'stopped'} presenting`);
  });

  // ========================================
  // NOTES EVENTS
  // ========================================

  socket.on('notes-update', ({ roomId, content }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    room.notes = content;
    socket.to(roomId).emit('notes-updated', { content });
  });

  socket.on('notes-present', ({ roomId, isPresenting }) => {
    io.to(roomId).emit('notes-present', {
      socketId: socket.id,
      username: currentUsername,
      isPresenting
    });
    console.log(`[Notes] ${currentUsername} ${isPresenting ? 'started' : 'stopped'} presenting`);
  });

  // ========================================
  // DISCONNECT EVENT
  // ========================================

  socket.on('disconnect', () => {
    console.log(`[Connection] Client disconnected: ${socket.id}`);

    // Clean up transcription session
    const session = transcriptionSessions.get(socket.id);
    if (session) {
      session.isActive = false;
      if (session.audioStream) {
        session.audioStream.end();
      }
      transcriptionSessions.delete(socket.id);
    }

    // Clean up room
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      const peer = room.peers.get(socket.id);

      if (peer) {
        // Close all transports
        peer.transports.forEach((transport) => transport.close());

        // Remove peer from room
        room.peers.delete(socket.id);

        // Notify other users
        socket.to(currentRoomId).emit('user-left', {
          socketId: socket.id,
          username: currentUsername
        });

        // Handle host migration if disconnected user was host
        if (room.hostId === socket.id) {
          migrateHost(room, currentRoomId, socket.id);
        }

        // Delete room if empty
        if (room.peers.size === 0) {
          deleteRoom(currentRoomId);
        }
      }
    }
  });
});

// ============================================================================
// REST API ENDPOINTS
// ============================================================================

app.get('/api/rooms/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms.get(roomId);

  if (room) {
    const users = [];
    room.peers.forEach((peer, socketId) => {
      users.push({
        socketId,
        username: peer.username,
        isHost: peer.isHost
      });
    });
    res.json({
      exists: true,
      userCount: room.peers.size,
      users
    });
  } else {
    res.json({
      exists: false,
      userCount: 0,
      users: []
    });
  }
});

app.get('/api/recordings/:roomId/:filename', (req, res) => {
  const { roomId, filename } = req.params;
  const filePath = path.join(__dirname, 'recordings', roomId, filename);

  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'Recording not found' });
  }
});

app.get('/api/recordings/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const recordingsDir = path.join(__dirname, 'recordings', roomId);

  if (!fs.existsSync(recordingsDir)) {
    return res.json({ recordings: [] });
  }

  const files = fs.readdirSync(recordingsDir);
  const recordings = files
    .filter(f => f.endsWith('-metadata.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(recordingsDir, f), 'utf8'));
      return {
        recordingId: data.recordingId,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        startedBy: data.startedBy,
        participants: data.participants,
        transcriptCount: data.transcripts?.length || 0,
        files: data.files
      };
    });

  res.json({ recordings });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    activeSessions: transcriptionSessions.size,
    activeRecordings: recordingSessions.size
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function startServer() {
  try {
    await createWorker();

    server.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════════╗
║  Server running successfully                               ║
╠════════════════════════════════════════════════════════════╣
║  Port:          ${PORT}                                    ║
║  Health Check:  http://localhost:${PORT}/health            ║
╚════════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down gracefully...');

  // Stop all active recordings
  for (const [roomId, recordingSession] of recordingSessions.entries()) {
    console.log(`[Server] Stopping recording for room ${roomId}`);
    stopRecording(roomId).catch(err => console.error('Error stopping recording:', err));
  }

  // Close all rooms
  rooms.forEach((room, roomId) => {
    deleteRoom(roomId);
  });

  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[Server] Received SIGTERM, shutting down...');

  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

// Start the server
startServer();