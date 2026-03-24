'use strict';

require('dotenv').config();

const express = require('express');
const { state } = require('./digest');
const { getAllTenants, getTenant, createTenant, deleteTenant } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Auth middleware for setup routes ────────────────────────────────────────

function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    // No token configured — allow access (first-time setup)
    return next();
  }
  const provided = req.query.token || req.headers['x-admin-token'];
  if (provided !== adminToken) {
    return res.status(401).send(setupPage(null, 'Invalid admin token.'));
  }
  next();
}

// ─── Setup page HTML ──────────────────────────────────────────────────────────

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••';
  return key.slice(0, 4) + '••••••••' + key.slice(-4);
}

function setupPage(tenants, flash) {
  const tokenParam = process.env.ADMIN_TOKEN
    ? `?token=${process.env.ADMIN_TOKEN}`
    : '';

  const rows = (tenants || [])
    .map((t) => {
      const emails = t.recipient_emails.split(',').map((e) => e.trim()).join('<br>');
      const status = t.last_digest_status
        ? `<span class="${t.last_digest_status === 'success' ? 'badge-ok' : 'badge-err'}">${t.last_digest_status === 'success' ? 'Sent' : 'Error'}</span>`
        : '<span class="badge-pending">Pending</span>';
      const lastRun = t.last_digest_at
        ? new Date(t.last_digest_at + ' UTC').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
        : '—';
      return `
        <tr>
          <td><strong>${escHtml(t.name)}</strong></td>
          <td class="mono">${escHtml(emails)}</td>
          <td class="mono small">${maskKey(t.hubspot_api_key)}</td>
          <td>${status}</td>
          <td class="small">${lastRun}</td>
          <td>
            <form method="POST" action="/setup/tenants/${t.id}/delete${tokenParam}" onsubmit="return confirm('Remove ${escHtml(t.name)}?')">
              <button type="submit" class="btn-remove">Remove</button>
            </form>
          </td>
        </tr>`;
    })
    .join('');

  const table = tenants && tenants.length > 0
    ? `<table>
        <thead><tr>
          <th>Company</th><th>Recipients</th><th>API Key</th><th>Last Status</th><th>Last Run</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
       </table>`
    : '<p class="empty">No companies added yet. Add your first one below.</p>';

  const flashHtml = flash
    ? `<div class="flash ${flash.startsWith('✓') ? 'flash-ok' : 'flash-err'}">${escHtml(flash)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HubSpot Digest — Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; min-height: 100vh; padding: 40px 20px; }
    .container { max-width: 860px; margin: 0 auto; }
    header { margin-bottom: 32px; }
    header h1 { font-size: 24px; font-weight: 700; }
    header p { color: #6e6e73; margin-top: 4px; font-size: 14px; }
    .card { background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 24px; }
    .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 20px; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group.full { grid-column: 1 / -1; }
    label { font-size: 13px; font-weight: 500; color: #3a3a3c; }
    input[type=text], input[type=email], input[type=password] {
      border: 1px solid #d2d2d7; border-radius: 8px; padding: 9px 12px;
      font-size: 14px; outline: none; width: 100%; transition: border-color .15s;
    }
    input:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,.15); }
    .hint { font-size: 12px; color: #6e6e73; margin-top: 2px; }
    .form-footer { margin-top: 20px; display: flex; justify-content: flex-end; }
    .btn-primary { background: #0071e3; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; }
    .btn-primary:hover { background: #0077ed; }
    .btn-remove { background: none; border: 1px solid #e5e5ea; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; color: #c0392b; }
    .btn-remove:hover { background: #fff0f0; border-color: #c0392b; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: #6e6e73; border-bottom: 1px solid #e5e5ea; padding: 8px 12px; }
    td { padding: 12px; border-bottom: 1px solid #f2f2f7; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: 'SF Mono', Menlo, monospace; }
    .small { font-size: 12px; color: #6e6e73; }
    .badge-ok  { background: #d1fae5; color: #065f46; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px; }
    .badge-err { background: #fee2e2; color: #991b1b; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px; }
    .badge-pending { background: #f3f4f6; color: #6b7280; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 20px; }
    .empty { color: #6e6e73; font-size: 14px; padding: 8px 0; }
    .flash { border-radius: 8px; padding: 12px 16px; font-size: 14px; margin-bottom: 20px; }
    .flash-ok  { background: #d1fae5; color: #065f46; }
    .flash-err { background: #fee2e2; color: #991b1b; }
    .section-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>HubSpot Activity Digest</h1>
      <p>Add companies to receive a daily email digest of their HubSpot activity.</p>
    </header>

    ${flashHtml}

    <div class="card">
      <h2>Companies (${(tenants || []).length})</h2>
      ${table}
    </div>

    <div class="card">
      <h2>Add a Company</h2>
      <form method="POST" action="/setup/tenants${tokenParam}">
        <div class="form-grid">
          <div class="form-group">
            <label for="name">Company Name</label>
            <input type="text" id="name" name="name" placeholder="Acme Corp" required>
          </div>
          <div class="form-group">
            <label for="recipient_emails">Recipient Email(s)</label>
            <input type="text" id="recipient_emails" name="recipient_emails" placeholder="ceo@acme.com, ops@acme.com" required>
            <span class="hint">Separate multiple addresses with commas</span>
          </div>
          <div class="form-group full">
            <label for="hubspot_api_key">HubSpot Private App Access Token</label>
            <input type="password" id="hubspot_api_key" name="hubspot_api_key" placeholder="pat-na1-••••••••" required>
            <span class="hint">Found in HubSpot → Settings → Integrations → Private Apps</span>
          </div>
        </div>
        <div class="form-footer">
          <button type="submit" class="btn-primary">Add Company</button>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

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
      smtpConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    },
    timestamp: new Date().toISOString(),
  });
});

// Setup page
app.get('/setup', requireAdmin, (req, res) => {
  const tenants = getAllTenants();
  res.send(setupPage(tenants, null));
});

// Add tenant
app.post('/setup/tenants', requireAdmin, (req, res) => {
  const tokenParam = process.env.ADMIN_TOKEN ? `?token=${process.env.ADMIN_TOKEN}` : '';
  const { name, hubspot_api_key, recipient_emails } = req.body;

  if (!name || !hubspot_api_key || !recipient_emails) {
    const tenants = getAllTenants();
    return res.send(setupPage(tenants, 'All fields are required.'));
  }

  try {
    createTenant({
      name: name.trim(),
      hubspotApiKey: hubspot_api_key.trim(),
      recipientEmails: recipient_emails.split(',').map((e) => e.trim()).filter(Boolean).join(', '),
    });
    res.redirect(`/setup${tokenParam}`);
  } catch (err) {
    const tenants = getAllTenants();
    res.send(setupPage(tenants, `Failed to save: ${err.message}`));
  }
});

// Delete tenant
app.post('/setup/tenants/:id/delete', requireAdmin, (req, res) => {
  const tokenParam = process.env.ADMIN_TOKEN ? `?token=${process.env.ADMIN_TOKEN}` : '';
  const tenant = getTenant(Number(req.params.id));
  if (tenant) deleteTenant(tenant.id);
  res.redirect(`/setup${tokenParam}`);
});

// Manual trigger endpoint (protected by TRIGGER_TOKEN)
app.post('/trigger', async (req, res) => {
  const triggerToken = process.env.TRIGGER_TOKEN;
  const authHeader = req.headers.authorization;

  if (triggerToken && authHeader !== `Bearer ${triggerToken}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  res.json({ message: 'Digest triggered. Check logs for progress.', triggeredAt: new Date().toISOString() });

  try {
    const { runAllTenants } = require('./digest');
    await runAllTenants();
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
  console.log(`Health check:   http://localhost:${PORT}/health`);
  console.log(`Setup page:     http://localhost:${PORT}/setup`);
  console.log(`Manual trigger: POST http://localhost:${PORT}/trigger`);
  if (!process.env.SMTP_HOST) {
    console.warn('WARNING: SMTP_HOST is not set — email sending will fail');
  }
});

module.exports = app;
