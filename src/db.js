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
  schemaReady = true;
}

async function getAllTenants() {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute('SELECT * FROM tenants WHERE is_active = 1 ORDER BY created_at ASC');
  return result.rows;
}

async function getTenant(id) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({ sql: 'SELECT * FROM tenants WHERE id = ?', args: [id] });
  return result.rows[0] || null;
}

async function createTenant({ name, hubspotApiKey, recipientEmails }) {
  await ensureSchema();
  const db = getClient();
  const result = await db.execute({
    sql: 'INSERT INTO tenants (name, hubspot_api_key, recipient_emails) VALUES (?, ?, ?)',
    args: [name, hubspotApiKey, recipientEmails],
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

module.exports = {
  getAllTenants,
  getTenant,
  createTenant,
  deleteTenant,
  updateTenantDigestStatus,
};
