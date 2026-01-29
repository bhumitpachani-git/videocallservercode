const roomManager = require('../services/room.service');
const { logUserJoin, saveChatTranscript, getRoomHistory } = require('../services/aws.service');
const logger = require('../utils/logger');

exports.getSystemMetrics = async (req, res) => {
  try {
    const totalRooms = roomManager.rooms.size;
    let totalParticipants = 0;
    roomManager.rooms.forEach(room => totalParticipants += room.peers.size);

    res.json({
      success: true,
      metrics: {
        totalActiveRooms: totalRooms,
        totalActiveParticipants: totalParticipants,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Error fetching system metrics:', error);
    res.status(500).json({ error: 'Internal Server Error' });
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
