'use strict';

require('dotenv').config();

const express = require('express');
const { state } = require('./digest');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Root health check
app.get('/', (req, res) => {
  res.send('HubSpot Digest Service Running');
});

// Detailed health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hubspot-activity-digest',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime()),
    lastRun: {
      at: state.lastRunAt,
      status: state.lastRunStatus,
      error: state.lastRunError,
    },
    config: {
      recipientsConfigured: Boolean(process.env.RECIPIENT_EMAILS),
      hubspotConfigured: Boolean(process.env.HUBSPOT_ACCESS_TOKEN),
    },
    timestamp: new Date().toISOString(),
  });
});

// Manual trigger endpoint (protected by a simple token)
app.post('/trigger', async (req, res) => {
  const triggerToken = process.env.TRIGGER_TOKEN;
  const authHeader = req.headers.authorization;

  if (triggerToken && authHeader !== `Bearer ${triggerToken}`) {
    return res.status(401).json({ error: 'Unauthorized. Set TRIGGER_TOKEN env var and pass as Bearer token.' });
  }

  console.log('Manual trigger received via POST /trigger');

  // Run digest in background so the HTTP response returns immediately
  res.json({ message: 'Digest triggered. Check logs for progress.', triggeredAt: new Date().toISOString() });

  try {
    const { runDigest } = require('./digest');
    await runDigest({ isTest: req.body?.test === true });
  } catch (err) {
    console.error('Manual trigger failed:', err.message);
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`HubSpot Digest server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Manual trigger: POST http://localhost:${PORT}/trigger`);
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    console.warn('WARNING: HUBSPOT_ACCESS_TOKEN is not set');
  }
  if (!process.env.RECIPIENT_EMAILS) {
    console.warn('WARNING: RECIPIENT_EMAILS is not set');
  }
});

module.exports = app;
