'use strict';

const { createClient } = require('@libsql/client');

// Local file fallback for development; Turso cloud URL for production
const TURSO_URL = process.env.TURSO_DATABASE_URL || 'file:./data/config.db';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

function getClient() {
  return createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
}

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  const db = getClient();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      trial_ends_at TEXT NOT NULL,
      subscription_status TEXT NOT NULL DEFAULT 'trial',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      hubspot_api_key TEXT NOT NULL,
      recipient_emails TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_digest_at TEXT,
      last_digest_status TEXT
    )
  `);

  // Migration: add user_id column to existing tenants table (ignore if already exists)
  try {
    await db.execute('ALTER TABLE tenants ADD COLUMN user_id INTEGER REFERENCES users(id)');
  } catch (_) {
    // Column already exists — safe to ignore
  }

  // Migration: add paypal_subscription_id column (ignore if already exists)
  try {
    await db.execute('ALTER TABLE users ADD COLUMN paypal_subscription_id TEXT');
  } catch (_) {
    // Column already exists — safe to ignore
  }

  // Migrations: per-tenant digest scheduling and reporting period
  const tenantMigrations = [
    "ALTER TABLE tenants ADD COLUMN digest_frequency TEXT NOT NULL DEFAULT 'daily'",
    'ALTER TABLE tenants ADD COLUMN digest_day INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE tenants ADD COLUMN digest_hour INTEGER NOT NULL DEFAULT 7',
    "ALTER TABLE tenants ADD COLUMN digest_timezone TEXT NOT NULL DEFAULT 'America/New_York'",
    'ALTER TABLE tenants ADD COLUMN report_period_days INTEGER NOT NULL DEFAULT 1',
  ];
  for (const sql of tenantMigrations) {
    try { await db.execute(sql); } catch (_) { /* column exists */ }
  }

  schemaReady = true;
}

// ─── User functions ──────────────────────────────────────────────────────────

async function createUser({ email, passwordHash, trialEndsAt }) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({
    sql: 'INSERT INTO users (email, password_hash, trial_ends_at) VALUES (?, ?, ?)',
    args: [email.toLowerCase().trim(), passwordHash, trialEndsAt],
  });
  return result.lastInsertRowid;
}

async function getUserByEmail(email) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE email = ?',
    args: [email.toLowerCase().trim()],
  });
  return result.rows[0] || null;
}

async function getUserById(id) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE id = ?',
    args: [id],
  });
  return result.rows[0] || null;
}

async function getUserByPaypalSubscription(paypalSubscriptionId) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({
    sql: 'SELECT * FROM users WHERE paypal_subscription_id = ?',
    args: [paypalSubscriptionId],
  });
  return result.rows[0] || null;
}

async function updateUserSubscription(id, { paypalSubscriptionId, status }) {
  const db = getClient();
  await db.execute({
    sql: `UPDATE users SET
      paypal_subscription_id = ?,
      subscription_status = ?
      WHERE id = ?`,
    args: [paypalSubscriptionId !== undefined ? paypalSubscriptionId : null, status, id],
  });
}

// ─── Tenant functions ─────────────────────────────────────────────────────────

async function getAllTenants() {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute('SELECT * FROM tenants WHERE is_active = 1 ORDER BY created_at ASC');
  return result.rows;
}

async function getAllTenantsForUser(userId) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({
    sql: 'SELECT * FROM tenants WHERE is_active = 1 AND user_id = ? ORDER BY created_at ASC',
    args: [userId],
  });
  return result.rows;
}

async function getTenant(id) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({ sql: 'SELECT * FROM tenants WHERE id = ?', args: [id] });
  return result.rows[0] || null;
}

async function getTenantForUser(id, userId) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({
    sql: 'SELECT * FROM tenants WHERE id = ? AND user_id = ?',
    args: [id, userId],
  });
  return result.rows[0] || null;
}

async function createTenant({ name, hubspotApiKey, recipientEmails, userId = null }) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({
    sql: 'INSERT INTO tenants (name, hubspot_api_key, recipient_emails, user_id) VALUES (?, ?, ?, ?)',
    args: [name, hubspotApiKey, recipientEmails, userId],
  });
  return result.lastInsertRowid;
}

async function deleteTenant(id) {
  const db = getClient();
  await db.execute({ sql: 'DELETE FROM tenants WHERE id = ?', args: [id] });
}

async function updateTenantDigestStatus(id, status) {
  const db = getClient();
  await db.execute({
    sql: 'UPDATE tenants SET last_digest_at = datetime("now"), last_digest_status = ? WHERE id = ?',
    args: [status, id],
  });
}

async function updateTenantTimezone(id, timezone) {
  const db = getClient();
  await db.execute({
    sql: 'UPDATE tenants SET digest_timezone = ? WHERE id = ?',
    args: [timezone, id],
  });
}

async function updateTenantSettings(id, { digestFrequency, digestDay, digestHour, digestTimezone, reportPeriodDays }) {
  const db = getClient();
  await db.execute({
    sql: `UPDATE tenants SET
      digest_frequency = ?,
      digest_day = ?,
      digest_hour = ?,
      digest_timezone = ?,
      report_period_days = ?
      WHERE id = ?`,
    args: [digestFrequency, digestDay, digestHour, digestTimezone, reportPeriodDays, id],
  });
}

async function getAllUsersWithTenants() {
  await ensureSchema();
  const db = getClient();
  const usersResult = await db.execute(
    'SELECT * FROM users ORDER BY created_at DESC'
  );
  const tenantsResult = await db.execute(
    'SELECT * FROM tenants WHERE is_active = 1 ORDER BY created_at ASC'
  );
  const tenantsByUser = {};
  for (const t of tenantsResult.rows) {
    const uid = String(t.user_id);
    if (!tenantsByUser[uid]) tenantsByUser[uid] = [];
    tenantsByUser[uid].push(t);
  }
  return usersResult.rows.map((u) => ({
    ...u,
    tenants: tenantsByUser[String(u.id)] || [],
  }));
}

module.exports = {
  // Users
  getAllUsersWithTenants,
  createUser,
  getUserByEmail,
  getUserById,
  getUserByPaypalSubscription,
  updateUserSubscription,
  // Tenants
  getAllTenants,
  getAllTenantsForUser,
  getTenant,
  getTenantForUser,
  createTenant,
  deleteTenant,
  updateTenantDigestStatus,
  updateTenantTimezone,
  updateTenantSettings,
};
