'use strict';
// Standalone read-only validation: never import db.js or initializeSchema.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
function validateDatabase(file) {
  if (!file || !path.isAbsolute(file)) throw new Error('An explicitly verified absolute database path is required.');
  if (!fs.statSync(file).isFile()) throw new Error('Database must be an existing regular file.');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON; BEGIN');
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || checks[0].quick_check !== 'ok') throw new Error('Database integrity check failed.');
    for (const [table, columns] of Object.entries({ chats: ['id', 'title', 'scroll_top'], messages: ['id', 'chat_id', 'role', 'content', 'telemetry_json'], users: ['id'], sessions: ['token_hash', 'user_id'] })) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      if (!columns.every(column => actual.includes(column))) throw new Error('Required application schema is absent.');
    }
    db.exec('ROLLBACK');
  } finally { if (db) db.close(); }
}
module.exports = { validateDatabase };
if (require.main === module) {
  try { validateDatabase(process.env.CHATBOT_DB_PATH); console.log('Existing database validation passed; no migrations executed.'); }
  catch { console.error('Database preflight failed: verify the explicit path, read access, SQLite integrity and application schema. No initialization attempted.'); process.exitCode = 1; }
}
