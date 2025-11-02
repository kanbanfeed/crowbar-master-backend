const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS
app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://crowbar-master-site.vercel.app',
    ],
    credentials: true,
  })
);



// --- Stripe webhook route: MUST use raw body & come before express.json() ---
const { handleWebhook } = require('./controllers/stripeController');
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

// JSON parser for all other routes
app.use(express.json());

const logger = (req, res, next) => {
  console.warn(`API HIT: ${req.method} ${req.url} - ${new Date().toISOString()}`);
  next();
};
app.use(logger);

// Routes
app.use('/api/credits', require('./routes/credits'));
app.use('/api/stripe', require('./routes/stripe'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Crowbar Credits API running' });
});
app.get('/', (req, res) => {
  res.json({ message: 'Backend is working!' });
});
// Test route
app.get('/test', (req, res) => {
  res.json({ message: 'Backend is working!' });
});

app.use('/api/gate', require('./routes/gate'));
// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Crowbar Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 Test route: http://localhost:${PORT}/test`);
  console.log(`📍 Webhook: POST http://localhost:${PORT}/api/stripe/webhook`);
});
