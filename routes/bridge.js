const express = require('express');
const router = express.Router();
const {
  syncLogin,
  syncCheckout
} = require('../controllers/bridgeController');

// POST /api/bridge/sync-login
router.post('/sync-login', syncLogin);

// POST /api/bridge/sync-checkout
router.post('/sync-checkout', syncCheckout);

module.exports = router;
