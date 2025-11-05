const express = require('express');
const router = express.Router();
const { startGate, completeGate } = require('../controllers/gateController');

// Start gate 
router.post('/start', startGate);

// Complete gate
router.post('/complete', completeGate);

module.exports = router;
