const express = require('express');
const router = express.Router();
const { earnCredits, getBalance, spendCredits } = require('../controllers/creditsController');

// POST /api/credits/earn
router.post('/earn', earnCredits);

// GET /api/credits/balance?email=user@example.com
router.get('/balance', getBalance);

// POST /api/credits/spend
router.post('/spend', spendCredits);

module.exports = router;