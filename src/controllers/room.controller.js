const os = require('os');
const roomManager = require('../services/room.service');
const { getRoomHistory } = require('../services/aws.service');
const logger = require('../utils/logger');

exports.getSystemMetrics = async (req, res) => {
  try {
    const rooms = Array.from(roomManager.rooms.values()).map(room => ({
      id: room.id,
      hostUsername: room.peers.get(room.hostId)?.username || 'No Host',
      userCount: room.peers.size,
      isRecording: !!room.recordingId,
      hasWhiteboard: room.whiteboard?.strokes.length > 0,
      createdAt: room.createdAt,
      currentVibe: room.currentVibe || 'neutral',
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
        rss: (mem.rss / 1024 / 1024).toFixed(2), // Resident Set Size
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
    const history = await getRoomHistory(req.params.roomId);
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
      activeParticipants: room.peers.size,
      hostId: room.hostId,
      createdAt: room.createdAt,
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
    const history = await getRoomHistory(roomId);

    const adminData = {
      roomId,
      isLive: !!liveRoom,
      liveDetails: liveRoom ? {
        activeParticipants: liveRoom.peers.size,
        participants: Array.from(liveRoom.peers.values()).map(p => ({
          username: p.username,
          joinedAt: p.joinedAt
        })),
        createdAt: liveRoom.createdAt,
        settings: liveRoom.settings
      } : null,
      history: history.map(item => ({
        type: item.type,
        timestamp: item.timestamp,
        details: item
      }))
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
      hasPassword: !!room.password,
      settings: room.settings,
      activeParticipants: room.peers.size,
      createdAt: room.createdAt
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
    await saveChatTranscript(roomId, req.body.transcript);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
