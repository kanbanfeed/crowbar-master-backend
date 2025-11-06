const express = require('express');
const router = express.Router();
const {createCheckoutSession, getSessionStatus, testManualPayment, getUserAccess, syncUserAccess,} = require('../controllers/stripeController');

router.post('/create-checkout-session', createCheckoutSession);
router.get('/session-status/:sessionId', getSessionStatus);
router.post('/test-manual-payment', testManualPayment);
router.get('/user', getUserAccess);
router.post('/sync-user', syncUserAccess);

module.exports = router;
