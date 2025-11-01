// routes/gate.js
const express = require('express');
const router = express.Router();
const { startGate, completeGate } = require('../controllers/gateController');

// Start gate (from CTA clicks)
router.post('/start', startGate);

// Complete gate (from payment-success page)
router.post('/complete', completeGate);

module.exports = router;
