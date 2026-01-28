const roomManager = require('../services/room.service');
const { logUserJoin, saveChatTranscript, getRoomHistory } = require('../services/aws.service');
const logger = require('../utils/logger');

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
