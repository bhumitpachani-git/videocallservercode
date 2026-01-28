const express = require('express');
const router = express.Router();
const roomController = require('../controllers/room.controller');

router.get('/:roomId', roomController.getRoom);
router.get('/:roomId/admin', roomController.getAdminRoom);
router.post('/:roomId/settings', roomController.updateSettings);
router.post('/:roomId/transcript', roomController.saveTranscript);

module.exports = router;
