'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'config.db');

function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
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
  return db;
}

function getAllTenants() {
  const db = openDb();
  return db.prepare('SELECT * FROM tenants WHERE is_active = 1 ORDER BY created_at ASC').all();
}

function getTenant(id) {
  const db = openDb();
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

function createTenant({ name, hubspotApiKey, recipientEmails }) {
  const db = openDb();
  const result = db
    .prepare('INSERT INTO tenants (name, hubspot_api_key, recipient_emails) VALUES (?, ?, ?)')
    .run(name, hubspotApiKey, recipientEmails);
  return result.lastInsertRowid;
}

function deleteTenant(id) {
  const db = openDb();
  db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
}

function updateTenantDigestStatus(id, status) {
  const db = openDb();
  db.prepare(
    'UPDATE tenants SET last_digest_at = datetime("now"), last_digest_status = ? WHERE id = ?'
  ).run(status, id);
}

module.exports = {
  getAllTenants,
  getTenant,
  createTenant,
  deleteTenant,
  updateTenantDigestStatus,
};
