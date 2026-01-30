const os = require('os');
const roomManager = require('../services/room.service');
const { getRoomHistory, getOrganizedRoomHistory, getSessionHistory } = require('../services/aws.service');
const logger = require('../utils/logger');

exports.getAllRoomIds = async (req, res) => {
  try {
    const rooms = Array.from(roomManager.rooms.keys());
    res.json({ roomIds: rooms });
  } catch (error) {
    logger.error(`Get all room IDs error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getRoomDetails = async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = roomManager.rooms.get(roomId);
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const details = {
      id: room.id,
      sessionId: room.sessionId,
      sessionNumber: room.sessionNumber,
      hostId: room.hostId,
      createdAt: room.createdAt,
      sessionStartedAt: room.sessionStartedAt,
      settings: room.settings,
      currentVibe: room.currentVibe,
      userCount: room.peers.size,
      peers: Array.from(room.peers.values()).map(p => ({
        id: p.id,
        username: p.username,
        isHost: p.id === room.hostId,
        joinedAt: p.joinedAt,
        producerCount: p.producers.size
      })),
      chatMessageCount: room.chatMessages?.length || 0,
      pollCount: room.polls?.size || 0,
      hasNotes: !!(room.notes && room.notes.length > 0),
      hasWhiteboard: room.whiteboard?.strokes.length > 0,
      isRecording: !!room.recordingId
    };

    res.json(details);
  } catch (error) {
    logger.error(`Get room details error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
};

exports.getSystemMetrics = async (req, res) => {
  try {
    const rooms = Array.from(roomManager.rooms.values()).map(room => ({
      id: room.id,
      sessionId: room.sessionId,
      sessionNumber: room.sessionNumber,
      hostUsername: room.peers.get(room.hostId)?.username || 'No Host',
      userCount: room.peers.size,
      isRecording: !!room.recordingId,
      hasWhiteboard: room.whiteboard?.strokes.length > 0,
      createdAt: room.createdAt,
      sessionStartedAt: room.sessionStartedAt,
      participants: Array.from(room.peers.values()).map(p => ({
        username: p.username,
        joinedAt: p.joinedAt,
        isHost: room.hostId === p.id,
        isRecorder: p.isRecorder,
        producerCount: p.producers.size
      })),
      settings: room.settings
    }));

    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    res.json({
      totalRooms: rooms.length,
      totalUsers: rooms.reduce((acc, r) => acc + r.userCount, 0),
      uptime: process.uptime(),
      cpuLoad: os.loadavg()[0].toFixed(2),
      memory: {
        rss: (mem.rss / 1024 / 1024).toFixed(2),
        heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(2),
        heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2),
        external: (mem.external / 1024 / 1024).toFixed(2),
        systemTotal: (totalMem / 1024 / 1024 / 1024).toFixed(2),
        systemFree: (freeMem / 1024 / 1024 / 1024).toFixed(2),
        systemUsed: ((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(2)
      },
      rooms
    });
  } catch (error) {
    logger.error('Error fetching system metrics:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.getHistory = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { organized, sessionId } = req.query;
    
    if (sessionId) {
      const sessionHistory = await getSessionHistory(roomId, sessionId);
      return res.json({
        roomId,
        sessionId,
        events: sessionHistory
      });
    }
    
    if (organized === 'true') {
      const organizedHistory = await getOrganizedRoomHistory(roomId);
      return res.json(organizedHistory);
    }
    
    const history = await getRoomHistory(roomId);
    res.json(history);
  } catch (error) {
    logger.error(`Error fetching history for room ${req.params.roomId}:`, error);
    res.status(500).json({ error: error.message });
  }
};

exports.getAllRooms = async (req, res) => {
  try {
    const activeRooms = Array.from(roomManager.rooms.entries()).map(([id, room]) => ({
      roomId: id,
      sessionId: room.sessionId,
      sessionNumber: room.sessionNumber,
      activeParticipants: room.peers.size,
      hostId: room.hostId,
      createdAt: room.createdAt,
      sessionStartedAt: room.sessionStartedAt,
      settings: room.settings
    }));

    res.json({
      totalActiveRooms: activeRooms.length,
      rooms: activeRooms
    });
  } catch (error) {
    logger.error('Error fetching all rooms:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getAdminRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const liveRoom = roomManager.rooms.get(roomId);
    const organizedHistory = await getOrganizedRoomHistory(roomId);

    const adminData = {
      roomId,
      isLive: !!liveRoom,
      liveDetails: liveRoom ? {
        sessionId: liveRoom.sessionId,
        sessionNumber: liveRoom.sessionNumber,
        activeParticipants: liveRoom.peers.size,
        participants: Array.from(liveRoom.peers.values()).map(p => ({
          username: p.username,
          joinedAt: p.joinedAt,
          isHost: p.id === liveRoom.hostId
        })),
        createdAt: liveRoom.createdAt,
        sessionStartedAt: liveRoom.sessionStartedAt,
        settings: liveRoom.settings,
        chatMessageCount: liveRoom.chatMessages?.length || 0,
        pollCount: liveRoom.polls?.size || 0,
        hasNotes: !!(liveRoom.notes && liveRoom.notes.length > 0),
        hasWhiteboard: liveRoom.whiteboard?.strokes?.length > 0
      } : null,
      history: organizedHistory
    };

    res.json(adminData);
  } catch (error) {
    logger.error(`Admin API error for room ${req.params.roomId}:`, error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.getRoom = async (req, res) => {
  try {
    const room = await roomManager.getOrCreateRoom(req.params.roomId);
    res.json({
      roomId: room.id,
      sessionId: room.sessionId,
      sessionNumber: room.sessionNumber,
      hasPassword: !!room.password,
      settings: room.settings,
      activeParticipants: room.peers.size,
      createdAt: room.createdAt,
      sessionStartedAt: room.sessionStartedAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await roomManager.getOrCreateRoom(roomId);
    room.settings = { ...room.settings, ...req.body };
    res.json({ success: true, settings: room.settings });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

exports.saveTranscript = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { saveChatTranscript } = require('../services/aws.service');
    const room = roomManager.rooms.get(roomId);
    if (room) {
      await saveChatTranscript(roomId, room.sessionId, req.body.transcript);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
