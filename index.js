const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://crowbar-master-site.vercel.app',
      'http://localhost:5173',
      "https://www.ecoworldbuy.com",
      "https://www.careduel.com",
      "https://www.talentkonnect.com",
      "http://localhost:3001"
    ],
    credentials: true,
  })
);

// Enhanced logger middleware
const logger = (req, res, next) => {
  console.warn(`API HIT: ${req.method} ${req.url} - ${new Date().toISOString()}`);
  next();
};
app.use(logger); 

// Stripe webhook route
const { handleWebhook } = require('./controllers/stripeController');
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

// JSON parser for all other routes
app.use(express.json());

// Routes
app.use('/api/credits', require('./routes/credits'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/gate', require('./routes/gate'));
app.use('/api/bridge', require('./routes/bridge'));



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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

// 404 handler 
app.use('*', (req, res) => {
  console.warn(`404 - NOT FOUND: ${req.method} ${req.originalUrl} - ${new Date().toISOString()}`);
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Crowbar Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`📍 Test route: http://localhost:${PORT}/test`);
  console.log(`📍 Webhook: POST http://localhost:${PORT}/api/stripe/webhook`);
});