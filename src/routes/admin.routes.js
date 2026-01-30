const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');

router.get('/active', adminController.getActiveRooms);
router.get('/history/:roomId', adminController.getHistory);
router.post('/control', adminController.controlRoom);

module.exports = router;