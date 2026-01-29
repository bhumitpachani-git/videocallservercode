const { joinRoomSchema, transportSchema, recordingSchema } = require('../utils/validation');
const logger = require('../utils/logger');
const { startRecording, stopRecording, recordingSessions } = require('./recording.service');
const { saveRoomDetails, saveChatTranscript, getRoomHistory } = require('./aws.service');
const { handleTranscription, transcriptionSessions } = require('./transcription.service');

module.exports = (io, roomManager) => {
  io.on('connection', (socket) => {
    logger.info(`New connection: ${socket.id}`);

    let currentRoomId = null;
    let currentUsername = null;

    socket.on('join-room', async (data, callback) => {
      try {
        const validated = joinRoomSchema.parse(data);
        const { roomId, username, password } = validated;
        
        let room = roomManager.rooms.get(roomId);

        if (!room) {
          room = await roomManager.getOrCreateRoom(roomId, password);
        }

        currentRoomId = roomId;
        currentUsername = username;

        // INSTANT RESPONSE: Send capabilities first so client can start WebRTC handshake
        const rtpCapabilities = room.router.rtpCapabilities;
        
        callback({
          rtpCapabilities,
          peers: Array.from(room.peers.values()).map(p => ({
            socketId: p.id,
            username: p.username,
            isHost: p.isHost
          })),
          whiteboard: room.whiteboard,
          notes: room.notes,
          polls: room.polls ? Array.from(room.polls.values()).map(p => ({
            id: p.id, question: p.question, options: p.options.map(o => o.text),
            creatorUsername: p.creatorUsername, isAnonymous: p.isAnonymous,
            allowMultiple: p.allowMultiple, createdAt: p.createdAt,
            results: p.options.map(o => o.votes), active: p.active
          })) : [],
          chatMessages: room.chatMessages || [],
          isHost: !room.hostId || room.hostId === socket.id,
          isRecording: recordingSessions.has(roomId)
        });

        // DEFERRED PROCESSING: Handle heavy logic after client is unblocked
        setImmediate(async () => {
          if (!room.hostId) {
            room.hostId = socket.id;
          }
          const isUserHost = room.hostId === socket.id;

          room.peers.set(socket.id, {
            id: socket.id,
            username,
            transports: new Map(),
            producers: new Map(),
            consumers: new Map(),
            isHost: isUserHost,
            joinedAt: Date.now()
          });

          socket.join(roomId);

          // Background producer sync
          const activeProducers = [];
          for (const [peerId, peer] of room.peers.entries()) {
            if (peerId !== socket.id) {
              for (const [producerId, producer] of peer.producers.entries()) {
                activeProducers.push({
                  socketId: peerId, producerId, kind: producer.kind, appData: producer.appData
                });
              }
            }
          }
          
          if (activeProducers.length > 0) {
            socket.emit('active-producers', activeProducers);
          }

          socket.to(roomId).emit('user-joined', {
            socketId: socket.id,
            username,
            isHost: isUserHost
          });
        });
      } catch (error) {
        logger.error(`Join room error: ${error.message}`);
        callback({ error: error.message });
      }
    });

    socket.on('mute-participant', ({ roomId, targetSocketId, kind }, callback) => {
      try {
        const room = roomManager.rooms.get(roomId);
        if (!room) throw new Error('Room not found');
        if (room.hostId !== socket.id) throw new Error('Only host can mute participants');

        io.to(targetSocketId).emit('force-mute', { kind });
        if (callback) callback({ success: true });

        logger.info(`Host ${currentUsername} muted ${kind} for ${targetSocketId}`);
      } catch (error) {
        logger.error(`Mute participant error: ${error.message}`);
        if (callback) callback({ error: error.message });
      }
    });

    socket.on('start-recording', async ({ roomId, username }, callback) => {
      logger.info(`Recording start request for room ${roomId} by ${username || currentUsername}`);

      try {
        const room = roomManager.rooms.get(roomId);
        if (!room) {
          const error = 'Room not found';
          socket.emit('recording-error', { error });
          if (callback) callback({ error });
          return;
        }

        if (recordingSessions.has(roomId)) {
          const error = 'Recording already in progress';
          socket.emit('recording-error', { error });
          if (callback) callback({ error });
          return;
        }

        const session = await startRecording(roomId, username || currentUsername, io, roomManager.rooms);

        const response = {
          success: true,
          recordingId: session.recordingId,
          startedBy: username || currentUsername,
          startedAt: session.startedAt || new Date().toISOString()
        };

        io.to(roomId).emit('recording-started', response);
        if (callback) callback(response);

        logger.info(`Recording started successfully for room ${roomId}`);
      } catch (error) {
        logger.error(`Start recording error: ${error.message}`);
        const errorMsg = error.message || 'Failed to start recording';
        socket.emit('recording-error', { error: errorMsg });
        if (callback) callback({ error: errorMsg });
      }
    });

    socket.on('stop-recording', async ({ roomId }, callback) => {
      logger.info(`Recording stop request for room ${roomId}`);

      try {
        const result = await stopRecording(roomId);

        const response = {
          success: true,
          recordingId: result.recordingId,
          downloadPath: `/api/recordings/${roomId}/${result.recordingId}-metadata.json`,
          files: result.files ? result.files.map(f => ({
            username: f.username,
            file: f.file,
            size: f.size,
            duration: f.duration,
            downloadPath: `/api/recordings/${roomId}/${f.file}`
          })) : [{
            file: result.file,
            size: result.size,
            downloadPath: `/api/recordings/${roomId}/${result.file}`
          }]
        };

        io.to(roomId).emit('recording-stopped', response);
        if (callback) callback(response);

        logger.info(`Recording stopped successfully for room ${roomId}`);
      } catch (error) {
        logger.error(`Stop recording error: ${error.message}`);
        const errorMsg = error.message || 'Failed to stop recording';
        socket.emit('recording-error', { error: errorMsg });
        if (callback) callback({ error: errorMsg });
      }
    });

    socket.on('start-transcription', async (data) => {
      try {
        await handleTranscription(socket, io, roomManager.rooms, recordingSessions, data);
      } catch (error) {
        logger.error(`Start transcription error: ${error.message}`);
      }
    });

    socket.on('audio-chunk', ({ roomId, username, audioData }) => {
      const session = transcriptionSessions.get(socket.id);
      if (session && session.audioStream && session.isActive) {
        try {
          const buffer = Buffer.from(new Int16Array(audioData).buffer);
          session.audioStream.write(buffer);
        } catch (error) {
          logger.error(`Audio chunk error: ${error.message}`);
        }
      }
    });

    socket.on('stop-transcription', ({ roomId }) => {
      const session = transcriptionSessions.get(socket.id);
      if (session) {
        session.isActive = false;
        if (session.audioStream) session.audioStream.end();
        transcriptionSessions.delete(socket.id);
        logger.info(`Transcription stopped for socket ${socket.id}`);
      }
    });

    socket.on('set-target-language', ({ roomId, targetLanguage }) => {
      const session = transcriptionSessions.get(socket.id);
      if (session) {
        session.targetLanguage = targetLanguage;
        logger.info(`Target language set to ${targetLanguage} for socket ${socket.id}`);
      }
    });

    socket.on('create-transport', async ({ roomId, direction }, callback) => {
      try {
        const room = await roomManager.getOrCreateRoom(roomId);
        const transport = await room.router.createWebRtcTransport(require('../config').webRtcTransportOptions);
        
        const peer = room.peers.get(socket.id);
        if (peer) peer.transports.set(transport.id, transport);

        transport.on('dtlsstatechange', (dtlsState) => {
          if (dtlsState === 'closed') transport.close();
        });

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        });
      } catch (error) {
        logger.error(`Transport creation error: ${error.message}`);
        callback({ error: 'Internal server error' });
      }
    });

    socket.on('connect-transport', async ({ transportId, dtlsParameters }, callback) => {
      try {
        const room = Array.from(roomManager.rooms.values()).find(r => r.peers.has(socket.id));
        const peer = room?.peers.get(socket.id);
        const transport = peer?.transports.get(transportId);

        if (transport) {
          await transport.connect({ dtlsParameters });
          callback({ success: true });
        } else {
          callback({ error: 'Transport not found' });
        }
      } catch (error) {
        logger.error(`Connect transport error: ${error.message}`);
        callback({ error: error.message });
      }
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
      try {
        const room = Array.from(roomManager.rooms.values()).find(r => r.peers.has(socket.id));
        const peer = room?.peers.get(socket.id);
        const transport = peer?.transports.get(transportId);

        if (transport) {
          const producer = await transport.produce({ kind, rtpParameters, appData });
          peer.producers.set(producer.id, producer);
          
          callback({ id: producer.id });
          
          socket.to(room.id).emit('new-producer', {
            socketId: socket.id,
            producerId: producer.id,
            kind: producer.kind,
            appData: producer.appData
          });
        }
      } catch (error) {
        logger.error(`Produce error: ${error.message}`);
        callback({ error: error.message });
      }
    });

    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
      try {
        const room = Array.from(roomManager.rooms.values()).find(r => r.peers.has(socket.id));
        const peer = room?.peers.get(socket.id);
        const transport = peer?.transports.get(transportId);

        if (!transport) {
          return callback({ error: 'Transport not found' });
        }

        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          return callback({ error: 'Cannot consume producer' });
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false // Ensure consumer starts unpaused
        });

        peer.consumers.set(consumer.id, consumer);

        callback({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters
        });
      } catch (error) {
        logger.error(`Consume error: ${error.message}`);
        callback({ error: error.message });
      }
    });

    socket.on('resume-consumer', async ({ consumerId }, callback) => {
      try {
        const room = Array.from(roomManager.rooms.values()).find(r => r.peers.has(socket.id));
        const peer = room?.peers.get(socket.id);
        const consumer = peer?.consumers.get(consumerId);

        if (consumer) {
          await consumer.resume();
          callback({ success: true });
        }
      } catch (error) {
        logger.error(`Resume consumer error: ${error.message}`);
        callback({ error: error.message });
      }
    });

    socket.on('get-producers', ({ roomId }, callback) => {
      try {
        const room = roomManager.rooms.get(roomId);
        if (!room) {
          if (callback) callback({ error: 'Room not found' });
          return;
        }

        const producers = [];
        for (const [peerId, peer] of room.peers.entries()) {
          if (peerId !== socket.id) {
            for (const [producerId, producer] of peer.producers.entries()) {
              producers.push({
                socketId: peerId,
                producerId: producerId,
                kind: producer.kind,
                appData: producer.appData
              });
            }
          }
        }

        if (callback) callback({ producers });
      } catch (error) {
        logger.error(`Get producers error: ${error.message}`);
        if (callback) callback({ error: error.message });
      }
    });

    socket.on('mark-screen-share', ({ roomId, producerId }) => {
      const room = roomManager.rooms.get(roomId);
      if (room) {
        socket.to(roomId).emit('screen-share-started', {
          socketId: socket.id,
          producerId,
          username: currentUsername
        });
        logger.info(`${currentUsername} started screen sharing in room ${roomId}`);
      }
    });

    socket.on('screen-share-stopped', ({ roomId }) => {
      const room = roomManager.rooms.get(roomId);
      if (room) {
        socket.to(roomId).emit('screen-share-ended', {
          socketId: socket.id,
          username: currentUsername
        });
        
        // Re-sync all producers in the room to ensure video recovery
        const producers = [];
        for (const [peerId, peer] of room.peers.entries()) {
          for (const [producerId, producer] of peer.producers.entries()) {
            producers.push({
              socketId: peerId,
              producerId: producerId,
              kind: producer.kind,
              appData: producer.appData
            });
          }
        }
        io.to(roomId).emit('active-producers', producers);

        logger.info(`${currentUsername} stopped screen sharing in room ${roomId}. Re-syncing producers.`);
      }
    });

    socket.on('chat-message', async ({ roomId, message }) => {
      const room = roomManager.rooms.get(roomId);
      if (room) {
        const chatMessage = {
          id: `${socket.id}-${Date.now()}`,
          socketId: socket.id,
          username: currentUsername,
          message,
          timestamp: new Date().toISOString()
        };

        if (!room.chatMessages) room.chatMessages = [];
        room.chatMessages.push(chatMessage);

        io.to(roomId).emit('chat-message', chatMessage);
        
        // Auto-save to DynamoDB
        await saveChatTranscript(roomId, room.chatMessages).catch(err => logger.error('Chat auto-save failed:', err));
      }
    });

    socket.on('send-chat-message', async ({ roomId, message }) => {
      const room = roomManager.rooms.get(roomId);
      if (room) {
        const chatMessage = {
          id: `${socket.id}-${Date.now()}`,
          socketId: socket.id,
          username: currentUsername,
          message,
          timestamp: new Date().toISOString()
        };

        if (!room.chatMessages) room.chatMessages = [];
        room.chatMessages.push(chatMessage);

        io.to(roomId).emit('chat-message', chatMessage);

        // Auto-save to DynamoDB
        await saveChatTranscript(roomId, room.chatMessages).catch(err => logger.error('Chat auto-save failed:', err));
      }
    });

    socket.on('peer-track-status', ({ roomId, kind, enabled }) => {
      const room = roomManager.rooms.get(roomId);
      if (room) {
        socket.to(roomId).emit('peer-track-status', {
          socketId: socket.id,
          username: currentUsername,
          kind,
          enabled
        });
      }
    });

    socket.on('create-poll', ({ roomId, question, options, isAnonymous, allowMultiple }) => {
      try {
        const room = roomManager.rooms.get(roomId);
        if (!room) return;

        const pollId = `poll-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const poll = {
          id: pollId,
          question,
          options: options.map(opt => ({ text: opt, votes: 0 })),
          creator: socket.id,
          creatorUsername: currentUsername,
          isAnonymous: isAnonymous || false,
          allowMultiple: allowMultiple || false,
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
          isAnonymous: poll.isAnonymous,
          allowMultiple: poll.allowMultiple,
          createdAt: poll.createdAt
        });

        logger.info(`Poll created in ${roomId}: ${question}`);
      } catch (error) {
        logger.error(`Create poll error: ${error.message}`);
        socket.emit('poll-error', { error: error.message });
      }
    });

    socket.on('submit-vote', ({ roomId, pollId, selectedOptions }) => {
      try {
        const room = roomManager.rooms.get(roomId);
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

        if (poll.votes.has(socket.id)) {
          const prev = poll.votes.get(socket.id);
          prev.forEach(idx => {
            if (poll.options[idx]) poll.options[idx].votes--;
          });
        }

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
        logger.error(`Submit vote error: ${error.message}`);
        socket.emit('poll-error', { error: error.message });
      }
    });

    socket.on('close-poll', ({ roomId, pollId }) => {
      try {
        const room = roomManager.rooms.get(roomId);
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

        logger.info(`Poll closed in ${roomId}: ${poll.question}`);
      } catch (error) {
        logger.error(`Close poll error: ${error.message}`);
      }
    });

    socket.on('whiteboard-clear', ({ roomId }) => {
      const room = roomManager.rooms.get(roomId);
      if (!room) return;

      room.whiteboard.strokes = [];
      io.to(roomId).emit('whiteboard-cleared');
    });

    socket.on('whiteboard-draw', async ({ roomId, stroke }) => {
      const room = roomManager.rooms.get(roomId);
      if (!room) return;

      room.whiteboard.strokes.push(stroke);
      socket.to(roomId).emit('whiteboard-draw', stroke);
      
      // Auto-save room details (whiteboard state)
      await saveRoomDetails({ roomId, whiteboard: room.whiteboard, action: 'WHITEBOARD_UPDATE' })
        .catch(err => logger.error('Whiteboard auto-save failed:', err));
    });

    socket.on('whiteboard-undo', async ({ roomId }) => {
      const room = roomManager.rooms.get(roomId);
      if (!room || room.whiteboard.strokes.length === 0) return;

      room.whiteboard.strokes.pop();
      io.to(roomId).emit('whiteboard-undo');

      // Auto-save room details (whiteboard state)
      await saveRoomDetails({ roomId, whiteboard: room.whiteboard, action: 'WHITEBOARD_UNDO' })
        .catch(err => logger.error('Whiteboard undo auto-save failed:', err));
    });

    socket.on('whiteboard-present', ({ roomId, isPresenting }) => {
      io.to(roomId).emit('whiteboard-present', {
        socketId: socket.id,
        username: currentUsername,
        isPresenting
      });
      logger.info(`${currentUsername} ${isPresenting ? 'started' : 'stopped'} whiteboard presentation`);
    });

    socket.on('notes-update', async ({ roomId, content }) => {
      const room = roomManager.rooms.get(roomId);
      if (!room) return;

      room.notes = content;
      socket.to(roomId).emit('notes-updated', { content });

      // Auto-save room details (notes state)
      await saveRoomDetails({ roomId, notes: room.notes, action: 'NOTES_UPDATE' })
        .catch(err => logger.error('Notes auto-save failed:', err));
    });

    socket.on('notes-present', ({ roomId, isPresenting }) => {
      io.to(roomId).emit('notes-present', {
        socketId: socket.id,
        username: currentUsername,
        isPresenting
      });
      logger.info(`${currentUsername} ${isPresenting ? 'started' : 'stopped'} notes presentation`);
    });

    socket.on('update-room-settings', async ({ roomId, settings }, callback) => {
      try {
        const room = await roomManager.getOrCreateRoom(roomId);
        room.settings = { ...room.settings, ...settings };
        await saveRoomDetails({ roomId, settings: room.settings, action: 'SETTINGS_UPDATED' });
        io.to(roomId).emit('room-settings-updated', room.settings);
        if (callback) callback({ success: true });
      } catch (error) {
        logger.error(`Settings update error: ${error.message}`);
        if (callback) callback({ error: 'Failed to update settings' });
      }
    });

    // Global broadcast for admin announcements
    socket.on('admin-broadcast', ({ message }) => {
      // Security: This would typically check for an admin token
      io.emit('system-announcement', {
        message,
        timestamp: new Date().toISOString()
      });
      logger.info(`Admin broadcast sent: ${message}`);
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);

      const session = transcriptionSessions.get(socket.id);
      if (session) {
        session.isActive = false;
        if (session.audioStream) session.audioStream.end();
        transcriptionSessions.delete(socket.id);
      }

      const room = Array.from(roomManager.rooms.values()).find(r => r.peers.has(socket.id));
      const roomId = room?.id;
      
      roomManager.handleDisconnect(socket.id);

      if (roomId) {
        const updatedRoom = roomManager.rooms.get(roomId);
        if (updatedRoom && updatedRoom.hostId) {
          io.to(roomId).emit('host-changed', { 
            newHostId: updatedRoom.hostId,
            username: updatedRoom.peers.get(updatedRoom.hostId)?.username
          });
        }
        socket.to(roomId).emit('user-left', { 
          socketId: socket.id,
          username: currentUsername
        });
      }
    });
  });
};
