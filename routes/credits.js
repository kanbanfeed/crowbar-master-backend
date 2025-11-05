const express = require('express');
const router = express.Router();
const { earnCredits, getBalance, spendCredits, applyReferralCode } = require('../controllers/creditsController');

// POST /api/credits/earn
router.post('/earn', earnCredits);

// GET /api/credits/balance?email=user@example.com
router.get('/balance', getBalance);

// POST /api/credits/spend
router.post('/spend', spendCredits);

// POST /api/credits/apply_referral_code
router.post('/apply_referral_code', applyReferralCode);

module.exports = router;
