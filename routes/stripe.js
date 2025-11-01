const express = require('express');
const router = express.Router();
const {
  createCheckoutSession,
  getSessionStatus,
  testManualPayment,
} = require('../controllers/stripeController');

// JSON-based endpoints
router.post('/create-checkout-session', createCheckoutSession);
router.get('/session-status/:sessionId', getSessionStatus);
router.post('/test-manual-payment', testManualPayment);

module.exports = router;
