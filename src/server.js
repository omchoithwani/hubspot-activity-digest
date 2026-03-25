'use strict';

require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { state, generateDigest } = require('./digest');
const {
  getAllTenants,
  getAllTenantsForUser,
  getTenant,
  getTenantForUser,
  createTenant,
  deleteTenant,
  updateTenantDigestStatus,
  updateTenantSettings,
  createUser,
  getUserByEmail,
} = require('./db');
const {
  requireAuth,
  loadUser,
  requireSubscription,
  setSessionCookie,
  clearSessionCookie,
  trialDaysLeft,
} = require('./auth');
const { PLANS, fetchLivePrices, createCheckoutSession, captureOrder, getSubscription, handleWebhookEvent } = require('./paypal');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── PayPal webhook — MUST be registered before body parsers ─────────────────

app.post(
  '/paypal/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const result = await handleWebhookEvent(req.body, req.headers);
      res.json({ received: true, ...result });
    } catch (err) {
      console.error('[paypal webhook]', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// ─── Body parsers + cookies ───────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••';
  return key.slice(0, 4) + '••••••••' + key.slice(-4);
}

function baseHead(title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)} — HubSpot Digest</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; min-height: 100vh; }
    a { color: #0071e3; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 880px; margin: 0 auto; padding: 40px 20px; }
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
    .form-footer { margin-top: 20px; display: flex; justify-content: flex-end; align-items: center; gap: 16px; }
    .btn-primary { background: #0071e3; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; }
    .btn-primary:hover { background: #0077ed; }
    .btn-secondary { background: #fff; color: #1d1d1f; border: 1px solid #d2d2d7; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; cursor: pointer; }
    .btn-secondary:hover { background: #f5f5f7; }
    .btn-remove { background: none; border: 1px solid #e5e5ea; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; color: #c0392b; }
    .btn-remove:hover { background: #fff0f0; border-color: #c0392b; }
    .btn-preview { display: inline-block; background: none; border: 1px solid #d2d2d7; border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #0071e3; text-decoration: none; margin-right: 6px; }
    .btn-preview:hover { background: #f0f6ff; border-color: #0071e3; }
    .btn-send { background: none; border: 1px solid #d2d2d7; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; color: #065f46; margin-right: 6px; }
    .btn-send:hover { background: #d1fae5; border-color: #065f46; }
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
    nav { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; background: #fff; border-bottom: 1px solid #e5e5ea; }
    nav .nav-logo { font-size: 15px; font-weight: 600; color: #1d1d1f; text-decoration: none; }
    nav .nav-links { display: flex; gap: 20px; align-items: center; font-size: 14px; }
    .trial-banner { background: #fffbeb; border-bottom: 1px solid #fde68a; padding: 10px 20px; text-align: center; font-size: 13px; color: #92400e; }
  </style>`;
}

function navbar(user) {
  return `
  <nav>
    <a class="nav-logo" href="/dashboard">HubSpot Digest</a>
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/billing">Billing</a>
      <span style="color:#6e6e73">${escHtml(user.email)}</span>
      <form method="POST" action="/logout" style="display:inline;">
        <button type="submit" class="btn-secondary" style="padding:6px 14px;font-size:13px;">Log out</button>
      </form>
    </div>
  </nav>`;
}

// ─── Auth pages ───────────────────────────────────────────────────────────────

function signupPage(flash) {
  const flashHtml = flash
    ? `<div class="flash flash-err">${escHtml(flash)}</div>`
    : '';
  return `${baseHead('Sign Up')}
</head>
<body>
  <div style="max-width:400px;margin:80px auto;padding:0 20px;">
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="font-size:22px;font-weight:700;">HubSpot Digest</h1>
      <p style="color:#6e6e73;font-size:14px;margin-top:6px;">Start your 14-day free trial</p>
    </div>
    ${flashHtml}
    <div class="card">
      <form method="POST" action="/signup">
        <div class="form-group" style="margin-bottom:16px;">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autocomplete="email">
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="new-password" minlength="8">
          <span class="hint">Minimum 8 characters</span>
        </div>
        <button type="submit" class="btn-primary" style="width:100%;justify-content:center;">Create account</button>
      </form>
    </div>
    <p style="text-align:center;font-size:13px;color:#6e6e73;">Already have an account? <a href="/login">Log in</a></p>
  </div>
</body>
</html>`;
}

function loginPage(flash) {
  const flashHtml = flash
    ? `<div class="flash flash-err">${escHtml(flash)}</div>`
    : '';
  return `${baseHead('Log In')}
</head>
<body>
  <div style="max-width:400px;margin:80px auto;padding:0 20px;">
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="font-size:22px;font-weight:700;">HubSpot Digest</h1>
      <p style="color:#6e6e73;font-size:14px;margin-top:6px;">Sign in to your account</p>
    </div>
    ${flashHtml}
    <div class="card">
      <form method="POST" action="/login">
        <div class="form-group" style="margin-bottom:16px;">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autocomplete="email">
        </div>
        <div class="form-group" style="margin-bottom:16px;">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn-primary" style="width:100%;justify-content:center;">Log in</button>
      </form>
    </div>
    <p style="text-align:center;font-size:13px;color:#6e6e73;">Don't have an account? <a href="/signup">Sign up free</a></p>
  </div>
</body>
</html>`;
}

// ─── Dashboard page ───────────────────────────────────────────────────────────

function dashboardPage(user, tenants, flash) {
  const daysLeft = trialDaysLeft(user);
  const trialBanner = user.subscription_status === 'trial'
    ? `<div class="trial-banner">
        ${daysLeft > 0
          ? `Your free trial ends in <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong>. <a href="/billing">Upgrade now</a> to keep your account active.`
          : 'Your free trial has expired. <a href="/billing">Upgrade now</a> to continue.'}
       </div>`
    : '';

  const flashHtml = flash
    ? `<div class="flash ${flash.startsWith('✓') || flash.startsWith('Sending') ? 'flash-ok' : 'flash-err'}">${escHtml(flash)}</div>`
    : '';

  const TIMEZONES = [
    'America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
    'America/Toronto','America/Vancouver','America/Sao_Paulo','America/Mexico_City',
    'Europe/London','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Rome',
    'Europe/Amsterdam','Europe/Stockholm','Europe/Zurich','Europe/Warsaw',
    'Asia/Dubai','Asia/Kolkata','Asia/Singapore','Asia/Tokyo','Asia/Seoul',
    'Asia/Shanghai','Asia/Bangkok','Asia/Jakarta',
    'Australia/Sydney','Australia/Melbourne','Australia/Brisbane','Pacific/Auckland',
    'UTC',
  ];

  const tenantCards = tenants.map((t) => {
    const emails = t.recipient_emails.split(',').map((e) => e.trim()).join(', ');
    const status = t.last_digest_status
      ? `<span class="${t.last_digest_status === 'success' ? 'badge-ok' : 'badge-err'}">${t.last_digest_status === 'success' ? 'Sent' : 'Error'}</span>`
      : '<span class="badge-pending">Pending</span>';
    const lastRun = t.last_digest_at
      ? new Date(t.last_digest_at + ' UTC').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
      : '—';
    const freq = t.digest_frequency || 'daily';
    const hour = Number(t.digest_hour ?? 7);
    const tz = t.digest_timezone || 'America/New_York';
    const period = Number(t.report_period_days) || 1;
    const day = Number(t.digest_day ?? 1);
    const hourLabel = `${String(hour).padStart(2,'0')}:00`;
    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const scheduleLabel = freq === 'weekly' ? `Weekly on ${DAYS[day]} at ${hourLabel}` : `Daily at ${hourLabel}`;
    const periodLabel = period === 1 ? 'Yesterday' : `Last ${period} days`;

    const tzOptions = TIMEZONES.map((z) =>
      `<option value="${z}"${z === tz ? ' selected' : ''}>${z}</option>`
    ).join('');

    const dayOptions = DAYS.map((d, i) =>
      `<option value="${i}"${i === day ? ' selected' : ''}>${d}</option>`
    ).join('');

    return `
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div style="flex:1;min-width:200px;">
            <strong style="font-size:15px;">${escHtml(t.name)}</strong>
            <div class="small" style="margin-top:4px;">${escHtml(emails)}</div>
            <div class="small" style="margin-top:2px;">Key: ${maskKey(t.hubspot_api_key)}</div>
            <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              ${status}
              <span class="small">Last run: ${lastRun}</span>
            </div>
            <div class="small" style="margin-top:6px;color:#6e6e73;">
              ${escHtml(scheduleLabel)} &middot; ${escHtml(periodLabel)} &middot; ${escHtml(tz)}
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <a href="/dashboard/preview/${t.id}" target="_blank" class="btn-preview">Preview</a>
            <form method="POST" action="/dashboard/tenants/${t.id}/send" onsubmit="return confirm('Send digest now for ${escHtml(t.name)}?')" style="display:inline;">
              <button type="submit" class="btn-send">Send Now</button>
            </form>
            <form method="POST" action="/dashboard/tenants/${t.id}/delete" onsubmit="return confirm('Remove ${escHtml(t.name)}?')" style="display:inline;">
              <button type="submit" class="btn-remove">Remove</button>
            </form>
          </div>
        </div>

        <details style="margin-top:16px;">
          <summary style="font-size:13px;font-weight:500;cursor:pointer;color:#0071e3;">Schedule &amp; reporting settings</summary>
          <form method="POST" action="/dashboard/tenants/${t.id}/settings" style="margin-top:12px;">
            <div class="form-grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;">
              <div class="form-group">
                <label>Frequency</label>
                <select name="digest_frequency" style="border:1px solid #d2d2d7;border-radius:8px;padding:9px 12px;font-size:14px;width:100%;">
                  <option value="daily"${freq === 'daily' ? ' selected' : ''}>Daily</option>
                  <option value="weekly"${freq === 'weekly' ? ' selected' : ''}>Weekly</option>
                </select>
              </div>
              <div class="form-group">
                <label>Day (weekly only)</label>
                <select name="digest_day" style="border:1px solid #d2d2d7;border-radius:8px;padding:9px 12px;font-size:14px;width:100%;">
                  ${dayOptions}
                </select>
              </div>
              <div class="form-group">
                <label>Send hour (0–23)</label>
                <input type="number" name="digest_hour" min="0" max="23" value="${hour}" style="border:1px solid #d2d2d7;border-radius:8px;padding:9px 12px;font-size:14px;width:100%;">
                <span class="hint">In the timezone below</span>
              </div>
              <div class="form-group">
                <label>Reporting period</label>
                <select name="report_period_days" style="border:1px solid #d2d2d7;border-radius:8px;padding:9px 12px;font-size:14px;width:100%;">
                  <option value="1"${period === 1 ? ' selected' : ''}>Yesterday (1 day)</option>
                  <option value="7"${period === 7 ? ' selected' : ''}>Last 7 days</option>
                  <option value="30"${period === 30 ? ' selected' : ''}>Last 30 days</option>
                </select>
              </div>
              <div class="form-group" style="grid-column:1/-1;">
                <label>Timezone</label>
                <select name="digest_timezone" style="border:1px solid #d2d2d7;border-radius:8px;padding:9px 12px;font-size:14px;width:100%;">
                  ${tzOptions}
                </select>
              </div>
            </div>
            <div style="margin-top:12px;">
              <button type="submit" class="btn-primary" style="padding:8px 18px;font-size:13px;">Save Settings</button>
            </div>
          </form>
        </details>
      </div>`;
  }).join('');

  const tenantsSection = tenants.length > 0 ? tenantCards
    : '<p class="empty">No companies added yet. Add your first one below.</p>';

  return `${baseHead('Dashboard')}
</head>
<body>
  ${navbar(user)}
  ${trialBanner}
  <div class="container">
    ${flashHtml}

    <div style="margin-bottom:24px;">
      <h2 style="font-size:16px;font-weight:600;margin-bottom:16px;">Your Companies (${tenants.length})</h2>
      ${tenantsSection}
    </div>

    <div class="card">
      <h2>Add a Company</h2>
      <form method="POST" action="/dashboard/tenants">
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

// ─── Billing page ─────────────────────────────────────────────────────────────

function billingPage(user, flash, expired, livePrices = {}) {
  const daysLeft = trialDaysLeft(user);
  const status = user.subscription_status;

  const flashHtml = flash
    ? `<div class="flash ${flash.startsWith('✓') ? 'flash-ok' : 'flash-err'}">${escHtml(flash)}</div>`
    : '';

  const expiredBanner = expired
    ? `<div class="flash flash-err" style="margin-bottom:24px;">Your trial has expired. Choose a plan below to continue.</div>`
    : '';

  const statusBadge = {
    trial: `<span class="badge-pending">Trial — ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left</span>`,
    active: '<span class="badge-ok">Active</span>',
    lifetime: '<span class="badge-ok">Lifetime</span>',
    cancelled: '<span class="badge-err">Cancelled</span>',
  }[status] || `<span class="badge-pending">${escHtml(status)}</span>`;

  const isSubscribed = status === 'active' || status === 'lifetime';
  const planCards = isSubscribed ? '' : Object.entries(PLANS)
    .map(([key, plan]) => {
      const displayPrice = livePrices[key] || '—';
      const badge = plan.badge ? `<span style="background:#0071e3;color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;margin-left:8px;">${escHtml(plan.badge)}</span>` : '';
      return `
        <div style="border:1px solid #e5e5ea;border-radius:10px;padding:20px;flex:1;min-width:200px;">
          <div style="font-size:15px;font-weight:600;margin-bottom:4px;">${escHtml(plan.label)}${badge}</div>
          <div style="font-size:28px;font-weight:700;margin:8px 0;">${escHtml(displayPrice)} <span style="font-size:14px;font-weight:400;color:#6e6e73;">${escHtml(plan.period)}</span></div>
          <div style="font-size:13px;color:#6e6e73;margin-bottom:20px;">${escHtml(plan.description)}</div>
          <form method="POST" action="/billing/checkout">
            <input type="hidden" name="plan" value="${escHtml(key)}">
            <button type="submit" class="btn-primary" style="width:100%;">Choose ${escHtml(plan.label)}</button>
          </form>
        </div>`;
    })
    .join('');

  const portalSection = (status === 'active' || status === 'lifetime') && user.paypal_subscription_id
    ? `<div class="card">
        <h2>Manage Subscription</h2>
        <p style="font-size:14px;color:#6e6e73;margin-bottom:16px;">Update payment method or cancel your subscription via PayPal.</p>
        <a href="/billing/portal" class="btn-secondary">Manage on PayPal</a>
       </div>`
    : '';

  return `${baseHead('Billing')}
</head>
<body>
  ${navbar(user)}
  <div class="container">
    ${expiredBanner}
    ${flashHtml}

    <div class="card">
      <h2>Current Plan</h2>
      <p style="font-size:14px;color:#6e6e73;margin-bottom:8px;">Account: ${escHtml(user.email)}</p>
      <div>${statusBadge}</div>
    </div>

    ${portalSection}

    ${!isSubscribed ? `
    <div class="card">
      <h2>Choose a Plan</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        ${planCards}
      </div>
    </div>` : ''}
  </div>
</body>
</html>`;
}

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.get('/signup', (req, res) => {
  res.send(signupPage(null));
});

app.post('/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.send(signupPage('Email and password are required.'));
  if (password.length < 8) return res.send(signupPage('Password must be at least 8 characters.'));

  try {
    const existing = await getUserByEmail(email);
    if (existing) return res.send(signupPage('An account with that email already exists.'));

    const passwordHash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const userId = Number(await createUser({ email, passwordHash, trialEndsAt }));
    setSessionCookie(res, userId, email);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[signup]', err.message);
    res.send(signupPage('Something went wrong. Please try again.'));
  }
});

app.get('/login', (req, res) => {
  const flash = req.query.flash ? decodeURIComponent(req.query.flash) : null;
  res.send(loginPage(flash));
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.send(loginPage('Email and password are required.'));

  try {
    const user = await getUserByEmail(email);
    if (!user) return res.send(loginPage('Invalid email or password.'));

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.send(loginPage('Invalid email or password.'));

    setSessionCookie(res, user.id, user.email);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[login]', err.message);
    res.send(loginPage('Something went wrong. Please try again.'));
  }
});

app.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/login');
});

// ─── Dashboard routes ─────────────────────────────────────────────────────────

app.get('/dashboard', requireAuth, loadUser, requireSubscription, async (req, res) => {
  const tenants = await getAllTenantsForUser(req.user.id);
  const flash = req.query.flash ? decodeURIComponent(req.query.flash) : null;
  res.send(dashboardPage(req.dbUser, tenants, flash));
});

app.post('/dashboard/tenants', requireAuth, loadUser, requireSubscription, async (req, res) => {
  const { name, hubspot_api_key, recipient_emails } = req.body;

  if (!name || !hubspot_api_key || !recipient_emails) {
    const tenants = await getAllTenantsForUser(req.user.id);
    return res.send(dashboardPage(req.dbUser, tenants, 'All fields are required.'));
  }

  try {
    await createTenant({
      name: name.trim(),
      hubspotApiKey: hubspot_api_key.trim(),
      recipientEmails: recipient_emails.split(',').map((e) => e.trim()).filter(Boolean).join(', '),
      userId: req.user.id,
    });
    res.redirect('/dashboard');
  } catch (err) {
    const tenants = await getAllTenantsForUser(req.user.id);
    res.send(dashboardPage(req.dbUser, tenants, `Failed to save: ${err.message}`));
  }
});

app.post('/dashboard/tenants/:id/delete', requireAuth, loadUser, async (req, res) => {
  const tenant = await getTenantForUser(Number(req.params.id), req.user.id);
  if (tenant) await deleteTenant(tenant.id);
  res.redirect('/dashboard');
});

app.post('/dashboard/tenants/:id/settings', requireAuth, loadUser, async (req, res) => {
  const tenant = await getTenantForUser(Number(req.params.id), req.user.id);
  if (!tenant) return res.redirect('/dashboard');

  const { digest_frequency, digest_day, digest_hour, digest_timezone, report_period_days } = req.body;

  const validFreq = ['daily', 'weekly'].includes(digest_frequency) ? digest_frequency : 'daily';
  const validDay = Math.max(0, Math.min(6, parseInt(digest_day) || 1));
  const validHour = Math.max(0, Math.min(23, parseInt(digest_hour) || 7));
  const validPeriod = [1, 7, 30].includes(parseInt(report_period_days)) ? parseInt(report_period_days) : 1;

  try {
    await updateTenantSettings(tenant.id, {
      digestFrequency: validFreq,
      digestDay: validDay,
      digestHour: validHour,
      digestTimezone: digest_timezone || 'America/New_York',
      reportPeriodDays: validPeriod,
    });
    const flash = encodeURIComponent(`✓ Settings saved for ${tenant.name}.`);
    res.redirect(`/dashboard?flash=${flash}`);
  } catch (err) {
    const flash = encodeURIComponent(`Failed to save settings: ${err.message}`);
    res.redirect(`/dashboard?flash=${flash}`);
  }
});

app.post('/dashboard/tenants/:id/send', requireAuth, loadUser, requireSubscription, async (req, res) => {
  const tenant = await getTenantForUser(Number(req.params.id), req.user.id);
  if (!tenant) return res.redirect('/dashboard');

  const sendingFlash = encodeURIComponent(`Sending digest for ${tenant.name}... check Last Status in a moment.`);
  res.redirect(`/dashboard?flash=${sendingFlash}`);

  const { runDigest } = require('./digest');
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  Promise.resolve()
    .then(() => runDigest({
      hubspotApiKey: tenant.hubspot_api_key,
      recipients: tenant.recipient_emails,
      previewUrl: appUrl ? `${appUrl}/dashboard/preview/${tenant.id}` : undefined,
      reportPeriodDays: Number(tenant.report_period_days) || 1,
    }))
    .then(() => updateTenantDigestStatus(tenant.id, 'success'))
    .then(() => console.log(`[send-now] Digest sent for tenant: ${tenant.name}`))
    .catch((err) => {
      console.error(`[send-now] Digest failed for ${tenant.name}:`, err.message);
      updateTenantDigestStatus(tenant.id, `error: ${err.message.slice(0, 200)}`).catch(() => {});
    });
});

app.get('/dashboard/preview/:id', requireAuth, loadUser, requireSubscription, async (req, res) => {
  const tenant = await getTenantForUser(Number(req.params.id), req.user.id);
  if (!tenant) return res.status(404).send('Not found.');

  try {
    const result = await generateDigest({
      skipEmail: true,
      hubspotApiKey: tenant.hubspot_api_key,
      reportPeriodDays: Number(tenant.report_period_days) || 1,
    });
    res.send(result.htmlBody);
  } catch (err) {
    res.status(500).send(`<pre>Error generating digest: ${escHtml(err.message)}</pre>`);
  }
});

// ─── Billing routes ───────────────────────────────────────────────────────────

app.get('/billing', requireAuth, loadUser, async (req, res) => {
  const flash = req.query.flash ? decodeURIComponent(req.query.flash) : null;
  const livePrices = await fetchLivePrices();
  res.send(billingPage(req.dbUser, flash, req.query.expired === '1', livePrices));
});

app.post('/billing/checkout', requireAuth, loadUser, async (req, res) => {
  const { plan } = req.body;
  if (!plan) return res.redirect('/billing');

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = await createCheckoutSession({ user: req.dbUser, plan, baseUrl });
    res.redirect(url);
  } catch (err) {
    console.error('[billing checkout]', err.message);
    const flash = encodeURIComponent(`Checkout failed: ${err.message}`);
    res.redirect(`/billing?flash=${flash}`);
  }
});

app.get('/billing/portal', requireAuth, loadUser, (req, res) => {
  // PayPal has no hosted portal — send users to their PayPal autopay page
  res.redirect('https://www.paypal.com/myaccount/autopay/');
});

app.get('/billing/success', requireAuth, loadUser, async (req, res) => {
  const { updateUserSubscription } = require('./db');
  const { type, subscription_id: subscriptionId, token: orderId } = req.query;

  try {
    if (type === 'subscription' && subscriptionId) {
      const sub = await getSubscription(subscriptionId);
      const [userId] = (sub.custom_id || '').split(':');
      if (Number(userId) === req.dbUser.id) {
        await updateUserSubscription(req.dbUser.id, {
          paypalSubscriptionId: sub.id,
          status: 'active',
        });
      }
    } else if (type === 'order' && orderId) {
      const capture = await captureOrder(orderId);
      const customId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id
        || capture.purchase_units?.[0]?.custom_id;
      const [userId, plan] = (customId || '').split(':');
      if (Number(userId) === req.dbUser.id && plan === 'lifetime') {
        await updateUserSubscription(req.dbUser.id, {
          paypalSubscriptionId: capture.purchase_units?.[0]?.payments?.captures?.[0]?.id || orderId,
          status: 'lifetime',
        });
      }
    }
  } catch (err) {
    console.error('[billing/success]', err.message);
  }

  res.send(`${baseHead('Payment Successful')}
</head>
<body>
  ${navbar(req.dbUser)}
  <div style="max-width:500px;margin:80px auto;padding:0 20px;text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">&#10003;</div>
    <h1 style="font-size:22px;font-weight:700;margin-bottom:8px;">Payment successful!</h1>
    <p style="font-size:14px;color:#6e6e73;margin-bottom:24px;">Your account is now active. Head to your dashboard to get started.</p>
    <a href="/dashboard" class="btn-primary" style="display:inline-block;padding:10px 24px;">Go to Dashboard</a>
  </div>
</body>
</html>`);
});

// ─── Legacy admin setup routes (backwards compatible) ────────────────────────

function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return next();
  const provided = req.query.token || req.headers['x-admin-token'];
  if (provided !== adminToken) return res.status(401).send('Unauthorized.');
  next();
}

function setupPage(tenants, flash) {
  const tokenParam = process.env.ADMIN_TOKEN ? `?token=${process.env.ADMIN_TOKEN}` : '';

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
          <td style="white-space:nowrap;">
            <a href="/preview/${t.id}${tokenParam}" target="_blank" class="btn-preview">Preview</a>
            <form method="POST" action="/setup/tenants/${t.id}/send${tokenParam}" onsubmit="return confirm('Send digest now for ${escHtml(t.name)}?')" style="display:inline;">
              <button type="submit" class="btn-send">Send Now</button>
            </form>
            <form method="POST" action="/setup/tenants/${t.id}/delete${tokenParam}" onsubmit="return confirm('Remove ${escHtml(t.name)}?')" style="display:inline;">
              <button type="submit" class="btn-remove">Remove</button>
            </form>
          </td>
        </tr>`;
    })
    .join('');

  const table = tenants && tenants.length > 0
    ? `<table><thead><tr><th>Company</th><th>Recipients</th><th>API Key</th><th>Last Status</th><th>Last Run</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p class="empty">No companies added yet.</p>';

  const flashHtml = flash
    ? `<div class="flash ${flash.startsWith('✓') || flash.startsWith('Sending') ? 'flash-ok' : 'flash-err'}">${escHtml(flash)}</div>`
    : '';

  return `${baseHead('Setup')}
</head>
<body>
  <div class="container">
    <header style="margin-bottom:32px;">
      <h1 style="font-size:24px;font-weight:700;">HubSpot Activity Digest</h1>
      <p style="color:#6e6e73;margin-top:4px;font-size:14px;">Admin Setup</p>
    </header>
    ${flashHtml}
    <div class="card"><h2>Companies (${(tenants || []).length})</h2>${table}</div>
    <div class="card">
      <h2>Add a Company</h2>
      <form method="POST" action="/setup/tenants${tokenParam}">
        <div class="form-grid">
          <div class="form-group"><label>Company Name</label><input type="text" name="name" required></div>
          <div class="form-group"><label>Recipient Email(s)</label><input type="text" name="recipient_emails" required><span class="hint">Comma-separated</span></div>
          <div class="form-group full"><label>HubSpot Access Token</label><input type="password" name="hubspot_api_key" required></div>
        </div>
        <div class="form-footer"><button type="submit" class="btn-primary">Add Company</button></div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

app.get('/setup', requireAdmin, async (req, res) => {
  const tenants = await getAllTenants();
  const flash = req.query.flash ? decodeURIComponent(req.query.flash) : null;
  res.send(setupPage(tenants, flash));
});

app.post('/setup/tenants', requireAdmin, async (req, res) => {
  const tokenParam = process.env.ADMIN_TOKEN ? `?token=${process.env.ADMIN_TOKEN}` : '';
  const { name, hubspot_api_key, recipient_emails } = req.body;
  if (!name || !hubspot_api_key || !recipient_emails) {
    const tenants = await getAllTenants();
    return res.send(setupPage(tenants, 'All fields are required.'));
  }
  try {
    await createTenant({
      name: name.trim(),
      hubspotApiKey: hubspot_api_key.trim(),
      recipientEmails: recipient_emails.split(',').map((e) => e.trim()).filter(Boolean).join(', '),
    });
    res.redirect(`/setup${tokenParam}`);
  } catch (err) {
    const tenants = await getAllTenants();
    res.send(setupPage(tenants, `Failed to save: ${err.message}`));
  }
});

app.post('/setup/tenants/:id/delete', requireAdmin, async (req, res) => {
  const tokenParam = process.env.ADMIN_TOKEN ? `?token=${process.env.ADMIN_TOKEN}` : '';
  const tenant = await getTenant(Number(req.params.id));
  if (tenant) await deleteTenant(tenant.id);
  res.redirect(`/setup${tokenParam}`);
});

app.post('/setup/tenants/:id/send', requireAdmin, async (req, res) => {
  const tokenParam = process.env.ADMIN_TOKEN ? `?token=${process.env.ADMIN_TOKEN}` : '';
  const tenant = await getTenant(Number(req.params.id));
  if (!tenant) return res.redirect(`/setup${tokenParam}`);

  const sendingFlash = encodeURIComponent(`Sending digest for ${tenant.name}... check Last Status in a moment.`);
  res.redirect(`/setup${tokenParam}${tokenParam ? '&' : '?'}flash=${sendingFlash}`);

  const { runDigest } = require('./digest');
  const { updateTenantDigestStatus: updateStatus } = require('./db');
  const appUrlAdmin = (process.env.APP_URL || '').replace(/\/$/, '');
  Promise.resolve()
    .then(() => runDigest({
      hubspotApiKey: tenant.hubspot_api_key,
      recipients: tenant.recipient_emails,
      previewUrl: appUrlAdmin ? `${appUrlAdmin}/dashboard/preview/${tenant.id}` : undefined,
    }))
    .then(() => updateStatus(tenant.id, 'success'))
    .then(() => console.log(`[send-now] Digest sent for tenant: ${tenant.name}`))
    .catch((err) => {
      console.error(`[send-now] Digest failed for ${tenant.name}:`, err.message);
      updateStatus(tenant.id, `error: ${err.message.slice(0, 200)}`).catch(() => {});
    });
});

// ─── Health + trigger + preview (legacy) ─────────────────────────────────────

app.get('/', (req, res) => res.redirect('/login'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hubspot-activity-digest',
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime()),
    lastRun: { at: state.lastRunAt, status: state.lastRunStatus, error: state.lastRunError },
    timestamp: new Date().toISOString(),
  });
});

app.post('/trigger', async (req, res) => {
  const triggerToken = process.env.TRIGGER_TOKEN;
  if (triggerToken && req.headers.authorization !== `Bearer ${triggerToken}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  res.json({ message: 'Digest triggered.', triggeredAt: new Date().toISOString() });
  try {
    const { runAllTenants } = require('./digest');
    await runAllTenants();
  } catch (err) {
    console.error('Manual trigger failed:', err.message);
  }
});

app.get('/preview/:id', requireAdmin, async (req, res) => {
  const tenant = await getTenant(Number(req.params.id));
  if (!tenant) return res.status(404).send('Not found.');
  try {
    const result = await generateDigest({ skipEmail: true, hubspotApiKey: tenant.hubspot_api_key });
    res.send(result.htmlBody);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${escHtml(err.message)}</pre>`);
  }
});

app.get('/preview', requireAdmin, async (req, res) => {
  const tenants = await getAllTenants();
  if (tenants.length === 1) {
    const tokenParam = process.env.ADMIN_TOKEN ? `?token=${process.env.ADMIN_TOKEN}` : '';
    return res.redirect(`/preview/${tenants[0].id}${tokenParam}`);
  }
  if (tenants.length > 1) {
    const tokenParam = process.env.ADMIN_TOKEN ? `?token=${process.env.ADMIN_TOKEN}` : '';
    const links = tenants.map((t) => `<li><a href="/preview/${t.id}${tokenParam}">${escHtml(t.name)}</a></li>`).join('');
    return res.send(`<!DOCTYPE html><html><head><title>Preview</title><style>body{font-family:system-ui;padding:40px;}li{margin:8px 0;}a{color:#0071e3;}</style></head><body><h2>Select a company</h2><ul>${links}</ul></body></html>`);
  }
  try {
    const result = await generateDigest({ skipEmail: true });
    res.send(result.htmlBody);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${escHtml(err.message)}</pre>`);
  }
});

// ─── Error handlers ───────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`HubSpot Digest server running on port ${PORT}`);
  console.log(`  Login:    http://localhost:${PORT}/login`);
  console.log(`  Sign up:  http://localhost:${PORT}/signup`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  Admin:    http://localhost:${PORT}/setup`);

  const cron = require('node-cron');
  const { runAllTenants } = require('./digest');
  // Run every hour at :00; per-tenant schedule is checked inside runAllTenants
  cron.schedule('0 * * * *', async () => {
    console.log(`[cron] Hourly check at ${new Date().toISOString()}`);
    try {
      await runAllTenants({ respectSchedule: true });
      console.log('[cron] Done.');
    } catch (err) {
      console.error('[cron] Failed:', err.message);
    }
  });
  console.log('  Scheduler: hourly (per-tenant schedule applies)');
});

module.exports = app;
