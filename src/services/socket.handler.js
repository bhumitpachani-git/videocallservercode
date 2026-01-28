const { joinRoomSchema, transportSchema, recordingSchema } = require('../utils/validation');
const logger = require('../utils/logger');
const { startRecording, stopRecording, recordingSessions } = require('./recording.service');
const { saveRoomDetails } = require('./aws.service');
const { handleTranscription, transcriptionSessions } = require('./transcription.service');

module.exports = (io, roomManager) => {
  io.on('connection', (socket) => {
    logger.info(`New connection: ${socket.id}`);

    socket.on('join-room', async (data, callback) => {
      try {
        const { error, value } = joinRoomSchema.validate(data);
        if (error) throw new Error(error.details[0].message);

        const result = await roomManager.joinRoom(socket, value);
        callback(result);
        
        // Notify others
        socket.to(value.roomId).emit('user-joined', { 
          socketId: socket.id, 
          username: value.recorder ? 'System Recorder' : value.username 
        });

        // If not a recorder, tell the new user about existing peers
        if (!value.recorder) {
          const room = await roomManager.getOrCreateRoom(value.roomId);
          const peers = [];
          for (const [peerId, peer] of room.peers.entries()) {
            if (peerId !== socket.id) {
              peers.push({
                socketId: peerId,
                username: peer.username
              });
            }
          }
          socket.emit('get-peers', peers);
        }
      } catch (error) {
        logger.error(`Join room error: ${error.message}`);
        callback({ error: 'Internal server error' });
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
        const room = Object.values(roomManager.rooms).find(r => r.peers.has(socket.id)) || 
                     Array.from(roomManager.rooms.values()).find(r => r.peers.has(socket.id));
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
          
          // Inform others
          socket.to(room.id).emit('new-producer', {
            socketId: socket.id,
            producerId: producer.id,
            kind: producer.kind
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

        if (transport && room.router.canConsume({ producerId, rtpCapabilities })) {
          const consumer = await transport.consume({
            producerId,
            rtpCapabilities,
            paused: true
          });

          peer.consumers.set(consumer.id, consumer);

          callback({
            id: consumer.id,
            producerId: consumer.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters
          });
        }
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

    socket.on('start-transcription', async (data) => {
      try {
        await handleTranscription(socket, io, roomManager.rooms, recordingSessions, data);
      } catch (error) {
        logger.error(`Start transcription error: ${error.message}`);
      }
    });

    socket.on('audio-chunk', (chunk) => {
      const session = transcriptionSessions.get(socket.id);
      if (session && session.isActive && session.audioStream) {
        session.audioStream.write(chunk);
      }
    });

    socket.on('stop-transcription', () => {
      const session = transcriptionSessions.get(socket.id);
      if (session) {
        session.isActive = false;
        if (session.audioStream) session.audioStream.end();
        transcriptionSessions.delete(socket.id);
      }
    });

    socket.on('start-recording', async ({ roomId }, callback) => {
      try {
        const session = await startRecording(roomId, socket.id, io, roomManager.rooms);
        io.to(roomId).emit('recording-started', { recordingId: session.recordingId });
        callback({ success: true });
      } catch (error) {
        logger.error(`Start recording error: ${error.message}`);
        callback({ error: 'Internal server error' });
      }
    });

    socket.on('stop-recording', async ({ roomId }, callback) => {
      try {
        const result = await stopRecording(roomId);
        io.to(roomId).emit('recording-stopped', result);
        callback({ success: true, result });
      } catch (error) {
        logger.error(`Stop recording error: ${error.message}`);
        callback({ error: 'Internal server error' });
      }
    });

    socket.on('update-room-settings', async ({ roomId, settings }, callback) => {
      try {
        const room = await roomManager.getOrCreateRoom(roomId);
        room.settings = { ...room.settings, ...settings };
        await saveRoomDetails({ roomId, settings: room.settings, action: 'SETTINGS_UPDATED' });
        io.to(roomId).emit('room-settings-updated', room.settings);
        callback({ success: true });
      } catch (error) {
        logger.error(`Settings update error: ${error.message}`);
        callback({ error: 'Failed to update settings' });
      }
    });

    socket.on('disconnect', () => {
      roomManager.handleDisconnect(socket.id);
    });
  });
};
