const express = require('express');
const router = express.Router();
const roomManager = require('../services/room.service');
const { logUserJoin, saveChatTranscript } = require('../services/aws.service');
const logger = require('../utils/logger');

// Get room details
router.get('/:roomId', async (req, res) => {
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
    res.status(500).json({ error: 'Failed to fetch room details' });
  }
});

// Update room settings
router.post('/:roomId/settings', async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await roomManager.getOrCreateRoom(roomId);
    room.settings = { ...room.settings, ...req.body };
    res.json({ success: true, settings: room.settings });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Save chat transcript
router.post('/:roomId/transcript', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { transcript } = req.body;
    await saveChatTranscript(roomId, transcript);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save transcript' });
  }
});

module.exports = router;
