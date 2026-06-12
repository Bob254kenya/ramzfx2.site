require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { initializeDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const corsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

// Middleware
app.use(helmet());
app.use(morgan('combined'));
app.use(
    cors(
        corsOrigins.length > 0
            ? {
                  origin(origin, callback) {
                      if (!origin || corsOrigins.includes(origin)) {
                          callback(null, true);
                          return;
                      }
                      callback(new Error(`Origin ${origin} is not allowed by CORS`));
                  },
              }
            : undefined
    )
);
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'API server is running' });
});

// Routes
app.use('/api/bot-ideas', require('./routes/bot-ideas'));
app.use('/api/best-bot-stats', require('./routes/best-bot-stats'));
app.use('/api/scanner', require('./routes/scanner'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/exchange-rates', require('./routes/exchange-rates'));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error',
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Initialize database and start server
async function start() {
    try {
        await initializeDatabase();

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`API server running on http://0.0.0.0:${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();

module.exports = app;
