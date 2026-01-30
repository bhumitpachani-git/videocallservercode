const roomManager = require('../services/room.service');
const { getRoomHistory } = require('../services/aws.service');
const logger = require('../utils/logger');

exports.getActiveRooms = (req, res) => {
    try {
        const rooms = Array.from(roomManager.rooms.values()).map(r => ({
            id: r.id,
            peersCount: r.peers.size,
            hostId: r.hostId,
            createdAt: r.createdAt,
            sessionId: r.sessionId
        }));
        res.json({ success: true, rooms });
    } catch (error) {
        logger.error(`Admin get active rooms error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.getHistory = async (req, res) => {
    try {
        const { roomId } = req.params;
        if (!roomId) throw new Error('Room ID required');
        
        const history = await getRoomHistory(roomId);
        res.json({ success: true, history });
    } catch (error) {
        logger.error(`Admin get history error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.controlRoom = async (req, res) => {
    try {
        const { roomId, action, data } = req.body;
        const room = roomManager.rooms.get(roomId);
        if (!room) throw new Error('Room not found');

        // Simple action handler
        switch (action) {
            case 'muteAll':
                // Logic to mute all
                break;
            case 'closeRoom':
                room.router.close();
                roomManager.rooms.delete(roomId);
                break;
            default:
                throw new Error('Invalid action');
        }

        res.json({ success: true });
    } catch (error) {
        logger.error(`Admin control room error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
};