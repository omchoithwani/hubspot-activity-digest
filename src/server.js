'use strict';

require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { state, generateDigest } = require('./digest');
const {
  adminUpdateUser,
  deleteUser,
  getAllUsersWithTenants,
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --blue:       #2563eb;
      --blue-hover: #1d4ed8;
      --blue-light: #eff6ff;
      --blue-ring:  rgba(37,99,235,.18);
      --green-bg:   #dcfce7; --green-fg: #166534;
      --red-bg:     #fee2e2; --red-fg:   #991b1b;
      --amber-bg:   #fef9c3; --amber-fg: #854d0e;
      --gray-50:  #f9fafb; --gray-100: #f3f4f6;
      --gray-200: #e5e7eb; --gray-300: #d1d5db;
      --gray-400: #9ca3af; --gray-500: #6b7280;
      --gray-700: #374151; --gray-900: #111827;
      --radius-sm: 6px; --radius: 10px; --radius-lg: 14px;
      --shadow-sm: 0 1px 2px rgba(0,0,0,.06);
      --shadow:    0 1px 4px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.04);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--gray-50); color: var(--gray-900); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Layout */
    .container { max-width: 900px; margin: 0 auto; padding: 36px 24px; }

    /* Cards */
    .card { background: #fff; border-radius: var(--radius-lg); padding: 24px; box-shadow: var(--shadow); margin-bottom: 20px; }
    .card-title { font-size: 15px; font-weight: 600; color: var(--gray-900); margin-bottom: 18px; }

    /* Section headers */
    .section-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--gray-400); margin-bottom: 12px; }

    /* Forms */
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    .form-group.full { grid-column: 1 / -1; }
    label { font-size: 13px; font-weight: 500; color: var(--gray-700); }
    input[type=text], input[type=email], input[type=password], input[type=number], select {
      border: 1.5px solid var(--gray-200); border-radius: var(--radius-sm);
      padding: 8px 11px; font-size: 14px; font-family: inherit;
      outline: none; width: 100%; transition: border-color .15s, box-shadow .15s;
      background: #fff; color: var(--gray-900); appearance: none; -webkit-appearance: none;
    }
    select { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236b7280' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 30px; }
    input:focus, select:focus { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-ring); }
    input[readonly] { background: var(--gray-50); color: var(--gray-500); cursor: default; }
    .hint { font-size: 12px; color: var(--gray-400); }
    .form-footer { margin-top: 18px; display: flex; justify-content: flex-end; align-items: center; gap: 12px; }

    /* Buttons */
    .btn-primary {
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--blue); color: #fff; border: none;
      border-radius: var(--radius-sm); padding: 9px 18px;
      font-size: 14px; font-weight: 500; font-family: inherit;
      cursor: pointer; transition: background .15s, transform .1s; letter-spacing: -.01em;
    }
    .btn-primary:hover { background: var(--blue-hover); }
    .btn-primary:active { transform: scale(.98); }
    .btn-secondary {
      display: inline-flex; align-items: center; justify-content: center;
      background: #fff; color: var(--gray-700); border: 1.5px solid var(--gray-200);
      border-radius: var(--radius-sm); padding: 9px 18px;
      font-size: 14px; font-weight: 500; font-family: inherit;
      cursor: pointer; transition: background .15s, border-color .15s; letter-spacing: -.01em;
    }
    .btn-secondary:hover { background: var(--gray-50); border-color: var(--gray-300); }
    .btn-sm {
      display: inline-flex; align-items: center; gap: 4px;
      border-radius: var(--radius-sm); padding: 5px 11px;
      font-size: 12px; font-weight: 500; font-family: inherit;
      cursor: pointer; transition: background .12s, border-color .12s; text-decoration: none;
    }
    .btn-outline    { background: #fff; color: var(--gray-700); border: 1.5px solid var(--gray-200); }
    .btn-outline:hover { background: var(--gray-50); border-color: var(--gray-300); text-decoration: none; }
    .btn-outline-blue { background: #fff; color: var(--blue); border: 1.5px solid var(--gray-200); }
    .btn-outline-blue:hover { background: var(--blue-light); border-color: var(--blue); text-decoration: none; }
    .btn-outline-green { background: #fff; color: var(--green-fg); border: 1.5px solid var(--gray-200); }
    .btn-outline-green:hover { background: var(--green-bg); border-color: var(--green-fg); }
    .btn-outline-red   { background: #fff; color: var(--red-fg);   border: 1.5px solid var(--gray-200); }
    .btn-outline-red:hover   { background: var(--red-bg);   border-color: var(--red-fg);   }

    /* Tables */
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--gray-400); border-bottom: 1px solid var(--gray-100); padding: 8px 12px; }
    td { padding: 11px 12px; border-bottom: 1px solid var(--gray-100); vertical-align: top; }
    tr:last-child td { border-bottom: none; }

    /* Misc */
    .mono { font-family: 'SF Mono', Menlo, 'Cascadia Code', monospace; }
    .small { font-size: 12px; color: var(--gray-500); }
    .muted { color: var(--gray-400); }

    /* Badges */
    .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 20px; }
    .badge::before { content: ''; width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
    .badge-ok      { background: var(--green-bg); color: var(--green-fg); }
    .badge-ok::before { background: var(--green-fg); }
    .badge-err     { background: var(--red-bg);   color: var(--red-fg);   }
    .badge-err::before { background: var(--red-fg); }
    .badge-pending { background: var(--gray-100); color: var(--gray-500); }
    .badge-pending::before { background: var(--gray-400); }

    /* Flash messages */
    .flash { display: flex; align-items: flex-start; gap: 10px; border-radius: var(--radius); padding: 12px 16px; font-size: 14px; margin-bottom: 20px; }
    .flash-ok  { background: var(--green-bg); color: var(--green-fg); border: 1px solid #bbf7d0; }
    .flash-err { background: var(--red-bg);   color: var(--red-fg);   border: 1px solid #fecaca; }

    /* Nav */
    .topnav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 24px; background: #fff; border-bottom: 1px solid var(--gray-200);
      height: 56px; position: sticky; top: 0; z-index: 100;
      box-shadow: 0 1px 3px rgba(0,0,0,.05);
    }
    .nav-brand { display: flex; align-items: center; gap: 9px; text-decoration: none; }
    .nav-brand-icon {
      width: 30px; height: 30px; border-radius: 8px;
      background: var(--blue); color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px; font-weight: 700; letter-spacing: -.02em; flex-shrink: 0;
    }
    .nav-brand-name { font-size: 15px; font-weight: 600; color: var(--gray-900); }
    .nav-links { display: flex; gap: 4px; align-items: center; }
    .nav-link { font-size: 14px; font-weight: 500; color: var(--gray-500); padding: 6px 10px; border-radius: var(--radius-sm); text-decoration: none; transition: color .12s, background .12s; }
    .nav-link:hover { color: var(--gray-900); background: var(--gray-100); text-decoration: none; }
    .nav-link.active { color: var(--blue); background: var(--blue-light); }
    .nav-divider { width: 1px; height: 20px; background: var(--gray-200); margin: 0 6px; }
    .nav-email { font-size: 13px; color: var(--gray-400); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Trial banner */
    .trial-banner { background: var(--amber-bg); border-bottom: 1px solid #fde68a; padding: 9px 24px; text-align: center; font-size: 13px; color: var(--amber-fg); }
    .trial-banner a { color: var(--amber-fg); font-weight: 600; text-decoration: underline; }

    /* Tenant card layout */
    .tenant-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .tenant-name { font-size: 15px; font-weight: 600; color: var(--gray-900); }
    .tenant-meta { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
    .tenant-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; flex-shrink: 0; }

    /* Settings panel */
    .settings-panel { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--gray-100); }
    .settings-toggle {
      display: flex; align-items: center; gap: 6px;
      font-size: 13px; font-weight: 500; color: var(--gray-500);
      cursor: pointer; list-style: none; user-select: none;
    }
    .settings-toggle::-webkit-details-marker { display: none; }
    .settings-toggle::before { content: '›'; font-size: 16px; transition: transform .2s; display: inline-block; }
    details[open] .settings-toggle::before { transform: rotate(90deg); }
    .settings-toggle:hover { color: var(--gray-900); }

    /* Plan cards */
    .plan-card {
      border: 1.5px solid var(--gray-200); border-radius: var(--radius-lg);
      padding: 24px; flex: 1; min-width: 190px;
      transition: border-color .15s, box-shadow .15s;
    }
    .plan-card:hover { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-ring); }
    .plan-card.featured { border-color: var(--blue); }

    /* Auth wrapper */
    .auth-wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
    .auth-box { width: 100%; max-width: 400px; }
    .auth-logo { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 28px; }
    .auth-logo-icon { width: 38px; height: 38px; border-radius: 10px; background: var(--blue); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; }
    .auth-logo-name { font-size: 20px; font-weight: 700; color: var(--gray-900); }

    /* Empty state */
    .empty-state { text-align: center; padding: 40px 20px; color: var(--gray-400); }
    .empty-state p { font-size: 14px; }

    /* Divider */
    .divider { border: none; border-top: 1px solid var(--gray-100); margin: 16px 0; }
  </style>`;
}

function navbar(user, activePage) {
  const isAdmin = (process.env.ADMIN_EMAIL || '').toLowerCase().trim() === (user.email || '').toLowerCase();
  const adminLink = isAdmin
    ? `<a href="/admin" class="nav-link${activePage === 'admin' ? ' active' : ''}" style="color:var(--red-fg);">Admin</a>`
    : '';
  return `
  <nav class="topnav">
    <a class="nav-brand" href="/dashboard">
      <div class="nav-brand-icon">H</div>
      <span class="nav-brand-name">HubSpot Digest</span>
    </a>
    <div class="nav-links">
      <a href="/dashboard" class="nav-link${activePage === 'dashboard' ? ' active' : ''}">Dashboard</a>
      <a href="/billing"   class="nav-link${activePage === 'billing'   ? ' active' : ''}">Billing</a>
      ${adminLink}
      <div class="nav-divider"></div>
      <span class="nav-email" title="${escHtml(user.email)}">${escHtml(user.email)}</span>
      <form method="POST" action="/logout" style="display:inline;margin-left:4px;">
        <button type="submit" class="btn-secondary" style="padding:5px 12px;font-size:13px;">Log out</button>
      </form>
    </div>
  </nav>`;
}

// ─── Auth pages ───────────────────────────────────────────────────────────────

function signupPage(flash) {
  const flashHtml = flash
    ? `<div class="flash flash-err"><span>⚠</span>${escHtml(flash)}</div>`
    : '';
  return `${baseHead('Sign Up')}
</head>
<body>
  <div class="auth-wrap">
    <div class="auth-box">
      <div class="auth-logo">
        <div class="auth-logo-icon">H</div>
        <span class="auth-logo-name">HubSpot Digest</span>
      </div>
      <div style="text-align:center;margin-bottom:24px;">
        <p style="color:var(--gray-500);font-size:14px;">Start your 14-day free trial — no credit card required</p>
      </div>
      ${flashHtml}
      <div class="card" style="padding:28px;">
        <form method="POST" action="/signup">
          <div class="form-group" style="margin-bottom:14px;">
            <label for="email">Email address</label>
            <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@company.com">
          </div>
          <div class="form-group" style="margin-bottom:20px;">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required autocomplete="new-password" minlength="8" placeholder="Min. 8 characters">
          </div>
          <button type="submit" class="btn-primary" style="width:100%;">Create free account</button>
        </form>
      </div>
      <p style="text-align:center;font-size:13px;color:var(--gray-400);margin-top:16px;">Already have an account? <a href="/login">Log in</a></p>
    </div>
  </div>
</body>
</html>`;
}

function loginPage(flash) {
  const flashHtml = flash
    ? `<div class="flash flash-err"><span>⚠</span>${escHtml(flash)}</div>`
    : '';
  return `${baseHead('Log In')}
</head>
<body>
  <div class="auth-wrap">
    <div class="auth-box">
      <div class="auth-logo">
        <div class="auth-logo-icon">H</div>
        <span class="auth-logo-name">HubSpot Digest</span>
      </div>
      <div style="text-align:center;margin-bottom:24px;">
        <p style="color:var(--gray-500);font-size:14px;">Sign in to your account</p>
      </div>
      ${flashHtml}
      <div class="card" style="padding:28px;">
        <form method="POST" action="/login">
          <div class="form-group" style="margin-bottom:14px;">
            <label for="email">Email address</label>
            <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@company.com">
          </div>
          <div class="form-group" style="margin-bottom:20px;">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="Your password">
          </div>
          <button type="submit" class="btn-primary" style="width:100%;">Log in</button>
        </form>
      </div>
      <p style="text-align:center;font-size:13px;color:var(--gray-400);margin-top:16px;">Don't have an account? <a href="/signup">Start free trial</a></p>
    </div>
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


  const tenantCards = tenants.map((t) => {
    const emails = t.recipient_emails.split(',').map((e) => e.trim()).join(', ');
    const statusBadge = t.last_digest_status
      ? (t.last_digest_status === 'success'
          ? '<span class="badge badge-ok">Sent</span>'
          : '<span class="badge badge-err">Error</span>')
      : '<span class="badge badge-pending">Pending</span>';
    const lastRun = t.last_digest_at
      ? new Date(t.last_digest_at + ' UTC').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
      : 'Never';
    const freq = t.digest_frequency || 'daily';
    const hour = Number(t.digest_hour ?? 7);
    const tz = t.digest_timezone || 'America/New_York';
    const period = Number(t.report_period_days) || 1;
    const day = Number(t.digest_day ?? 1);
    const ampm = hour >= 12 ? 'pm' : 'am';
    const h12 = hour % 12 || 12;
    const hourLabel = `${h12}:00 ${ampm}`;
    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const scheduleLabel = freq === 'weekly' ? `Weekly · ${DAYS[day]} at ${hourLabel}` : `Daily · ${hourLabel}`;
    const periodLabel = period === 1 ? '1-day report' : `${period}-day report`;

    const dayOptions = DAYS_SHORT.map((d, i) =>
      `<option value="${i}"${i === day ? ' selected' : ''}>${d}</option>`
    ).join('');

    const hourOptions = Array.from({length: 24}, (_, i) => {
      const ap = i >= 12 ? 'pm' : 'am';
      const h = i % 12 || 12;
      const label = `${h}:00 ${ap}`;
      return `<option value="${i}"${i === hour ? ' selected' : ''}>${label}</option>`;
    }).join('');

    return `
      <div class="card" style="margin-bottom:16px;">
        <div class="tenant-header">
          <div style="flex:1;min-width:200px;">
            <div class="tenant-name">${escHtml(t.name)}</div>
            <div class="tenant-meta">
              <span class="small">${escHtml(emails)}</span>
              <span class="small muted mono" style="font-size:11px;">Key: ${maskKey(t.hubspot_api_key)}</span>
            </div>
            <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              ${statusBadge}
              <span class="small">Last run: ${lastRun}</span>
            </div>
            <div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <span style="font-size:12px;background:var(--gray-100);color:var(--gray-500);border-radius:4px;padding:2px 7px;">${escHtml(scheduleLabel)}</span>
              <span style="font-size:12px;background:var(--gray-100);color:var(--gray-500);border-radius:4px;padding:2px 7px;">${escHtml(periodLabel)}</span>
              <span style="font-size:12px;background:var(--gray-100);color:var(--gray-500);border-radius:4px;padding:2px 7px;" title="Auto-synced from HubSpot">${escHtml(tz)}</span>
            </div>
          </div>
          <div class="tenant-actions">
            <a href="/dashboard/preview/${t.id}" target="_blank" class="btn-sm btn-outline-blue">Preview</a>
            <form method="POST" action="/dashboard/tenants/${t.id}/send" onsubmit="return confirm('Send digest now for ${escHtml(t.name)}?')" style="display:inline;">
              <button type="submit" class="btn-sm btn-outline-green">Send now</button>
            </form>
            <form method="POST" action="/dashboard/tenants/${t.id}/delete" onsubmit="return confirm('Remove ${escHtml(t.name)}?')" style="display:inline;">
              <button type="submit" class="btn-sm btn-outline-red">Remove</button>
            </form>
          </div>
        </div>

        <div class="settings-panel">
          <details>
            <summary class="settings-toggle">Schedule &amp; reporting settings</summary>
            <form method="POST" action="/dashboard/tenants/${t.id}/settings" style="margin-top:14px;">
              <div class="form-grid" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;">
                <div class="form-group">
                  <label>Frequency</label>
                  <select name="digest_frequency">
                    <option value="daily"${freq === 'daily' ? ' selected' : ''}>Daily</option>
                    <option value="weekly"${freq === 'weekly' ? ' selected' : ''}>Weekly</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Day <span class="muted" style="font-size:11px;font-weight:400;">(weekly)</span></label>
                  <select name="digest_day">${dayOptions}</select>
                </div>
                <div class="form-group">
                  <label>Send time</label>
                  <select name="digest_hour">${hourOptions}</select>
                </div>
                <div class="form-group">
                  <label>Reporting period</label>
                  <select name="report_period_days">
                    <option value="1"${period === 1 ? ' selected' : ''}>Yesterday (1 day)</option>
                    <option value="7"${period === 7 ? ' selected' : ''}>Last 7 days</option>
                    <option value="30"${period === 30 ? ' selected' : ''}>Last 30 days</option>
                  </select>
                </div>
              </div>
              <p class="hint" style="margin-top:10px;">Send time is in your HubSpot portal timezone (${escHtml(tz)}), synced automatically.</p>
              <div style="margin-top:12px;">
                <button type="submit" class="btn-primary" style="padding:8px 16px;font-size:13px;">Save settings</button>
              </div>
            </form>
          </details>
        </div>
      </div>`;
  }).join('');

  const tenantsSection = tenants.length > 0 ? tenantCards
    : `<div class="card"><div class="empty-state"><p>No companies yet. Add your first one below.</p></div></div>`;

  return `${baseHead('Dashboard')}
</head>
<body>
  ${navbar(user, 'dashboard')}
  ${trialBanner}
  <div class="container">
    ${flashHtml}

    <div style="margin-bottom:28px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="font-size:18px;font-weight:700;">Your Companies</h2>
        ${tenants.length > 0 ? `<span class="badge badge-pending" style="font-size:12px;">${tenants.length} connected</span>` : ''}
      </div>
      ${tenantsSection}
    </div>

    <div class="card">
      <div class="card-title">Connect a Company</div>
      <form method="POST" action="/dashboard/tenants">
        <div class="form-grid">
          <div class="form-group">
            <label for="name">Company name</label>
            <input type="text" id="name" name="name" placeholder="Acme Corp" required>
          </div>
          <div class="form-group">
            <label for="recipient_emails">Recipient email(s)</label>
            <input type="text" id="recipient_emails" name="recipient_emails" placeholder="ceo@acme.com, ops@acme.com" required>
            <span class="hint">Separate multiple addresses with commas</span>
          </div>
          <div class="form-group full">
            <label for="hubspot_api_key">HubSpot Private App Access Token</label>
            <input type="password" id="hubspot_api_key" name="hubspot_api_key" placeholder="pat-na1-••••••••" required>
          </div>
        </div>
        <div class="form-footer">
          <button type="submit" class="btn-primary">Connect company</button>
        </div>
      </form>

      <hr class="divider">

      <!-- How to create the key -->
      <details>
        <summary class="settings-toggle" style="color:var(--gray-500);">How to create your HubSpot Access Token</summary>
        <div style="margin-top:14px;display:flex;flex-direction:column;gap:10px;">
          <ol style="padding-left:18px;display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--gray-700);line-height:1.6;">
            <li>In HubSpot, go to <strong>Settings → Integrations → Private Apps</strong> (top-right gear icon).</li>
            <li>Click <strong>Create a private app</strong> and give it a name (e.g. "Activity Digest").</li>
            <li>Under the <strong>Scopes</strong> tab, add the following <em>read-only</em> scopes:
              <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;">
                ${[
                  'crm.objects.contacts.read',
                  'crm.objects.companies.read',
                  'crm.objects.deals.read',
                  'crm.objects.tasks.read',
                  'crm.objects.calls.read',
                  'crm.objects.emails.read',
                  'crm.objects.meetings.read',
                  'crm.objects.notes.read',
                  'crm.schemas.deals.read',
                  'crm.owners.read',
                  'account-info.security.read',
                ].map(s => `<code style="background:var(--gray-100);color:var(--gray-700);font-size:11px;font-family:'SF Mono',Menlo,monospace;padding:3px 7px;border-radius:4px;white-space:nowrap;">${s}</code>`).join('')}
              </div>
            </li>
            <li>Click <strong>Create app</strong>, then copy the access token shown.</li>
            <li>Paste it in the field above. You can revoke it from HubSpot at any time.</li>
          </ol>
        </div>
      </details>

      <hr class="divider">

      <!-- Data safety -->
      <details>
        <summary class="settings-toggle" style="color:var(--gray-500);">How is my data protected?</summary>
        <div style="margin-top:14px;display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--gray-700);line-height:1.6;">
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <span style="color:var(--green-fg);font-size:16px;flex-shrink:0;">✓</span>
            <span><strong>Read-only access.</strong> All scopes above are read-only. Even if your token were ever exposed, it cannot be used to create, modify, or delete anything in your HubSpot account.</span>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <span style="color:var(--green-fg);font-size:16px;flex-shrink:0;">✓</span>
            <span><strong>Token stored securely.</strong> Your access token is stored in an encrypted Turso database and is never exposed in the browser or included in emails.</span>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <span style="color:var(--green-fg);font-size:16px;flex-shrink:0;">✓</span>
            <span><strong>No data retention.</strong> HubSpot data is fetched fresh on each digest run and is not stored anywhere — only the summary email is sent to your chosen recipients.</span>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <span style="color:var(--blue);font-size:16px;flex-shrink:0;">ℹ</span>
            <span><strong>You stay in control.</strong> You can revoke your HubSpot token at any time from <strong>HubSpot → Settings → Private Apps</strong>, which will immediately stop all access.</span>
          </div>
        </div>
      </details>
    </div>
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
    ? `<div class="flash ${flash.startsWith('✓') ? 'flash-ok' : 'flash-err'}"><span>${flash.startsWith('✓') ? '✓' : '⚠'}</span>${escHtml(flash)}</div>`
    : '';

  const expiredBanner = expired
    ? `<div class="flash flash-err"><span>⚠</span>Your trial has expired. Choose a plan below to continue.</div>`
    : '';

  const statusBadge = {
    trial: `<span class="badge badge-pending">Trial · ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left</span>`,
    active:    '<span class="badge badge-ok">Active</span>',
    lifetime:  '<span class="badge badge-ok">Lifetime access</span>',
    cancelled: '<span class="badge badge-err">Cancelled</span>',
  }[status] || `<span class="badge badge-pending">${escHtml(status)}</span>`;

  const features = [
    'Unlimited HubSpot connections',
    'Daily or weekly digest emails',
    'Customisable reporting periods',
    'All activity types (tasks, calls, deals…)',
  ];
  const featuresHtml = features.map(f =>
    `<li style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gray-700);padding:4px 0;">
      <span style="color:var(--green-fg);font-size:14px;">✓</span>${f}
    </li>`
  ).join('');

  const isSubscribed = status === 'active' || status === 'lifetime';
  const planCards = isSubscribed ? '' : Object.entries(PLANS)
    .map(([key, plan]) => {
      const displayPrice = livePrices[key] || '—';
      const isFeatured = !!plan.badge;
      const badgeHtml = plan.badge
        ? `<span style="background:var(--blue);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;letter-spacing:.03em;text-transform:uppercase;">${escHtml(plan.badge)}</span>`
        : '';
      return `
        <div class="plan-card${isFeatured ? ' featured' : ''}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
            <span style="font-size:14px;font-weight:600;color:var(--gray-900);">${escHtml(plan.label)}</span>
            ${badgeHtml}
          </div>
          <div style="margin-bottom:4px;">
            <span style="font-size:32px;font-weight:700;letter-spacing:-.02em;">${escHtml(displayPrice)}</span>
            <span style="font-size:13px;color:var(--gray-400);margin-left:2px;">${escHtml(plan.period)}</span>
          </div>
          <p style="font-size:13px;color:var(--gray-500);margin-bottom:20px;line-height:1.5;">${escHtml(plan.description)}</p>
          <form method="POST" action="/billing/checkout">
            <input type="hidden" name="plan" value="${escHtml(key)}">
            <button type="submit" class="btn-primary" style="width:100%;${isFeatured ? '' : 'background:var(--gray-900);'}">Get started</button>
          </form>
        </div>`;
    })
    .join('');

  const portalSection = (status === 'active' || status === 'lifetime') && user.paypal_subscription_id
    ? `<div class="card">
        <div class="card-title">Manage Subscription</div>
        <p style="font-size:14px;color:var(--gray-500);margin-bottom:16px;">Update your payment method or cancel via PayPal's autopay manager.</p>
        <a href="/billing/portal" class="btn-secondary" style="display:inline-flex;align-items:center;gap:6px;">
          Manage on PayPal
          <span style="font-size:12px;opacity:.6;">↗</span>
        </a>
       </div>`
    : '';

  return `${baseHead('Billing')}
</head>
<body>
  ${navbar(user, 'billing')}
  <div class="container" style="max-width:780px;">
    ${expiredBanner}
    ${flashHtml}

    <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
      <div>
        <div class="card-title" style="margin-bottom:4px;">Current plan</div>
        <p style="font-size:13px;color:var(--gray-400);">${escHtml(user.email)}</p>
      </div>
      <div>${statusBadge}</div>
    </div>

    ${portalSection}

    ${!isSubscribed ? `
    <div class="card">
      <div class="card-title">Choose a plan</div>
      <ul style="list-style:none;margin-bottom:24px;padding:0;">${featuresHtml}</ul>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        ${planCards}
      </div>
      <p style="font-size:12px;color:var(--gray-400);margin-top:16px;text-align:center;">
        Payments processed securely by PayPal. Cancel any time.
      </p>
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

  const { digest_frequency, digest_day, digest_hour, report_period_days } = req.body;

  const validFreq = ['daily', 'weekly'].includes(digest_frequency) ? digest_frequency : 'daily';
  const validDay = Math.max(0, Math.min(6, parseInt(digest_day) || 1));
  const validHour = Math.max(0, Math.min(23, parseInt(digest_hour) || 7));
  const validPeriod = [1, 7, 30].includes(parseInt(report_period_days)) ? parseInt(report_period_days) : 1;

  try {
    await updateTenantSettings(tenant.id, {
      digestFrequency: validFreq,
      digestDay: validDay,
      digestHour: validHour,
      digestTimezone: tenant.digest_timezone || 'America/New_York', // preserved, updated automatically by HubSpot sync
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
      tenantId: tenant.id,
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

// ─── Admin ────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (!adminEmail) return res.status(403).send('Admin access not configured. Set ADMIN_EMAIL env var.');
  if (!req.user || req.user.email.toLowerCase() !== adminEmail) {
    return res.status(403).send('Forbidden.');
  }
  next();
}

function adminPage(users, flash) {
  const totalUsers    = users.length;
  const activeCount   = users.filter(u => u.subscription_status === 'active').length;
  const lifetimeCount = users.filter(u => u.subscription_status === 'lifetime').length;
  const trialCount    = users.filter(u => u.subscription_status === 'trial').length;
  const totalTenants  = users.reduce((sum, u) => sum + u.tenants.length, 0);

  const flashHtml = flash
    ? `<div class="flash ${flash.startsWith('✓') ? 'flash-ok' : 'flash-err'}" style="margin-bottom:20px;">${escHtml(flash)}</div>`
    : '';

  const statCards = [
    { label: 'Total users',   value: totalUsers },
    { label: 'Active (paid)', value: activeCount + lifetimeCount },
    { label: 'On trial',      value: trialCount },
    { label: 'Companies',     value: totalTenants },
  ].map(s => `
    <div style="background:#fff;border-radius:var(--radius-lg);padding:20px 24px;box-shadow:var(--shadow);text-align:center;flex:1;min-width:130px;">
      <div style="font-size:30px;font-weight:700;letter-spacing:-.02em;color:var(--gray-900);">${s.value}</div>
      <div style="font-size:12px;color:var(--gray-400);margin-top:2px;font-weight:500;">${s.label}</div>
    </div>`).join('');

  const userRows = users.map(u => {
    const trialEndsAt = new Date(u.trial_ends_at + ' UTC');
    const daysLeft = Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86400000));
    const trialDateValue = trialEndsAt.toISOString().split('T')[0];

    const statusBadge = {
      trial:     `<span class="badge badge-pending">Trial · ${daysLeft}d left</span>`,
      active:    '<span class="badge badge-ok">Active</span>',
      lifetime:  '<span class="badge badge-ok">Lifetime</span>',
      cancelled: '<span class="badge badge-err">Cancelled</span>',
    }[u.subscription_status] || `<span class="badge badge-pending">${escHtml(u.subscription_status)}</span>`;

    const joinedDate = new Date(u.created_at + ' UTC').toLocaleDateString('en-US', { dateStyle: 'medium' });

    const statusOpts = ['trial','active','lifetime','cancelled'].map(s =>
      `<option value="${s}"${u.subscription_status === s ? ' selected' : ''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`
    ).join('');

    const tenantRows = u.tenants.length === 0
      ? `<tr><td colspan="5" style="color:var(--gray-400);font-size:12px;padding:10px 12px;text-align:center;">No companies connected</td></tr>`
      : u.tenants.map(t => {
          const lastRun = t.last_digest_at
            ? new Date(t.last_digest_at + ' UTC').toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
            : '—';
          const tBadge = t.last_digest_status
            ? (t.last_digest_status === 'success' ? '<span class="badge badge-ok">OK</span>' : '<span class="badge badge-err">Error</span>')
            : '<span class="badge badge-pending">—</span>';
          return `<tr>
            <td style="padding:8px 12px;font-size:13px;font-weight:500;">${escHtml(t.name)}</td>
            <td style="padding:8px 12px;font-size:12px;color:var(--gray-500);">${escHtml(t.recipient_emails)}</td>
            <td style="padding:8px 12px;">${tBadge}</td>
            <td style="padding:8px 12px;font-size:12px;color:var(--gray-500);">${lastRun}</td>
            <td style="padding:8px 12px;">
              <div style="display:flex;gap:6px;">
                <form method="POST" action="/admin/tenants/${t.id}/send" style="display:inline;" onsubmit="return confirm('Send digest for ${escHtml(t.name)}?')">
                  <button class="btn-sm btn-outline-green" type="submit">Send digest</button>
                </form>
                <form method="POST" action="/admin/tenants/${t.id}/delete" style="display:inline;" onsubmit="return confirm('Delete company ${escHtml(t.name)}? This cannot be undone.')">
                  <button class="btn-sm btn-outline-red" type="submit">Delete</button>
                </form>
              </div>
            </td>
          </tr>`;
        }).join('');

    return `
      <div class="card" style="margin-bottom:16px;">
        <!-- User header -->
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
          <div>
            <div style="font-size:14px;font-weight:600;">${escHtml(u.email)}</div>
            <div style="font-size:12px;color:var(--gray-400);margin-top:2px;">Joined ${joinedDate} &middot; ID #${u.id}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            ${statusBadge}
            <span style="font-size:12px;background:var(--gray-100);color:var(--gray-500);border-radius:4px;padding:2px 7px;">${u.tenants.length} compan${u.tenants.length !== 1 ? 'ies' : 'y'}</span>
          </div>
        </div>

        <!-- Admin controls -->
        <div style="display:flex;gap:10px;flex-wrap:wrap;padding:14px;background:var(--gray-50);border-radius:var(--radius);border:1px solid var(--gray-200);">

          <!-- Change status -->
          <form method="POST" action="/admin/users/${u.id}/status" style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:12px;font-weight:500;color:var(--gray-500);white-space:nowrap;">Plan:</label>
            <select name="status" style="font-size:13px;padding:5px 28px 5px 8px;border:1.5px solid var(--gray-200);border-radius:var(--radius-sm);background:#fff;">${statusOpts}</select>
            <button type="submit" class="btn-sm btn-outline">Save</button>
          </form>

          <!-- Extend trial -->
          <form method="POST" action="/admin/users/${u.id}/trial" style="display:flex;align-items:center;gap:6px;">
            <label style="font-size:12px;font-weight:500;color:var(--gray-500);white-space:nowrap;">Trial ends:</label>
            <input type="date" name="trial_ends_at" value="${trialDateValue}"
              style="font-size:13px;padding:5px 8px;border:1.5px solid var(--gray-200);border-radius:var(--radius-sm);font-family:inherit;">
            <button type="submit" class="btn-sm btn-outline">Update</button>
          </form>

          <!-- Delete user -->
          <form method="POST" action="/admin/users/${u.id}/delete" style="margin-left:auto;"
            onsubmit="return confirm('Permanently delete ${escHtml(u.email)} and all their companies? This cannot be undone.')">
            <button type="submit" class="btn-sm btn-outline-red">Delete user</button>
          </form>
        </div>

        <!-- Companies table -->
        <div style="margin-top:14px;">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Recipients</th>
                <th>Last status</th>
                <th>Last run</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${tenantRows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  const fakeUser = { email: process.env.ADMIN_EMAIL || 'admin' };

  return `${baseHead('Admin')}
  <style>
    .admin-nav-badge { background:var(--red-bg);color:var(--red-fg);font-size:10px;font-weight:700;padding:1px 6px;border-radius:20px;letter-spacing:.04em;text-transform:uppercase;margin-left:6px; }
  </style>
</head>
<body>
  ${navbar(fakeUser, 'admin')}
  <div class="container" style="max-width:980px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px;">
      <h1 style="font-size:20px;font-weight:700;">Admin</h1>
      <span class="admin-nav-badge">Owner</span>
    </div>

    ${flashHtml}

    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:28px;">
      ${statCards}
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
      <h2 style="font-size:16px;font-weight:600;">All Users</h2>
      <span class="small">${totalUsers} total</span>
    </div>

    ${users.length === 0
      ? `<div class="card"><div class="empty-state"><p>No users yet.</p></div></div>`
      : userRows}
  </div>
</body>
</html>`;
}

// Admin routes
app.get('/admin', requireAuth, loadUser, requireAdmin, async (req, res) => {
  const users = await getAllUsersWithTenants();
  const flash = req.query.flash ? decodeURIComponent(req.query.flash) : null;
  res.send(adminPage(users, flash));
});

app.post('/admin/users/:id/status', requireAuth, loadUser, requireAdmin, async (req, res) => {
  const validStatuses = ['trial', 'active', 'lifetime', 'cancelled'];
  const status = validStatuses.includes(req.body.status) ? req.body.status : null;
  if (!status) return res.redirect('/admin?flash=' + encodeURIComponent('Invalid status.'));
  await adminUpdateUser(Number(req.params.id), { status });
  res.redirect('/admin?flash=' + encodeURIComponent(`✓ Plan updated to "${status}".`));
});

app.post('/admin/users/:id/trial', requireAuth, loadUser, requireAdmin, async (req, res) => {
  const dateStr = req.body.trial_ends_at;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.redirect('/admin?flash=' + encodeURIComponent('Invalid date.'));
  }
  const trialEndsAt = dateStr + ' 00:00:00';
  await adminUpdateUser(Number(req.params.id), { trialEndsAt });
  res.redirect('/admin?flash=' + encodeURIComponent(`✓ Trial updated to ${dateStr}.`));
});

app.post('/admin/users/:id/delete', requireAuth, loadUser, requireAdmin, async (req, res) => {
  await deleteUser(Number(req.params.id));
  res.redirect('/admin?flash=' + encodeURIComponent('✓ User deleted.'));
});

app.post('/admin/tenants/:id/delete', requireAuth, loadUser, requireAdmin, async (req, res) => {
  await deleteTenant(Number(req.params.id));
  res.redirect('/admin?flash=' + encodeURIComponent('✓ Company deleted.'));
});

app.post('/admin/tenants/:id/send', requireAuth, loadUser, requireAdmin, async (req, res) => {
  const tenant = await getTenant(Number(req.params.id));
  if (!tenant) return res.redirect('/admin?flash=' + encodeURIComponent('Company not found.'));

  res.redirect('/admin?flash=' + encodeURIComponent(`Sending digest for ${tenant.name}…`));

  const { runDigest } = require('./digest');
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  Promise.resolve()
    .then(() => runDigest({
      hubspotApiKey: tenant.hubspot_api_key,
      recipients: tenant.recipient_emails,
      previewUrl: appUrl ? `${appUrl}/dashboard/preview/${tenant.id}` : undefined,
      reportPeriodDays: Number(tenant.report_period_days) || 1,
      tenantId: tenant.id,
    }))
    .then(() => updateTenantDigestStatus(tenant.id, 'success'))
    .catch(err => updateTenantDigestStatus(tenant.id, `error: ${err.message.slice(0, 200)}`).catch(() => {}));
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
