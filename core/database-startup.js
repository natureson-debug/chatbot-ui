'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { initializeSchema } = require('./database-schema');
const databasePath = root => path.resolve(root, 'data', 'chatbot.db');
function failure(code, detail, cause) {
 const error = new Error(`${code}: ${detail}`, { cause }); error.code = code; return error;
}
function openExistingDatabase(file) {
 let db;
 try {
  // URI mode=rw is enforced by SQLite, not an existence-check/open race.
  const uri = pathToFileURL(file); uri.searchParams.set('mode', 'rw');
  db = new DatabaseSync(uri.href);
  // Recognize the original chat schema, allowing later migrations to add columns/tables.
  for (const [table, required] of Object.entries({chats:['id','title','scroll_top'],messages:['id','chat_id','role','content','telemetry_json']})) {
   const entry=db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(table);
   const columns = entry?.type==='table' ? db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name) : [];
   if (!required.every(c=>columns.includes(c))) throw failure('DB_SCHEMA_INVALID','Expected Chatbot schema is absent; restore the reviewed database. Do not initialize over it.');
  }
  const checks = db.prepare('PRAGMA quick_check').all();
  if (checks.length!==1 || checks[0].quick_check!=='ok') throw failure('DB_INVALID','SQLite integrity check failed; review recovery backup.');
  initializeSchema(db);
  return db;
 } catch(cause) {
  if (db) { try { db.close(); } catch {} }
  if (cause.code==='DB_SCHEMA_INVALID'||cause.code==='DB_INVALID') throw cause;
  throw failure('DB_STARTUP_FAILED',`Cannot open or migrate existing database at ${file}. Verify file, access, lock state and backup; first-run initialization is a separate command.`,cause);
 }
}
function initializeDatabase(file) {
 // Exclusive reservation prevents overwriting an existing database, including an empty one.
 let fd, db;
 try {
  fd=fs.openSync(file,'wx',0o600); fs.closeSync(fd); fd=undefined;
  const uri=pathToFileURL(file);uri.searchParams.set('mode','rw');
  db=new DatabaseSync(uri.href);initializeSchema(db);db.close();db=undefined;
 } catch(cause) {
  if(fd!==undefined)fs.closeSync(fd);
  if(db)try{db.close();}catch{}
  // Leave a failed reservation for review. Never delete/retry or silently replace it.
  throw failure('DB_INITIALIZATION_FAILED','Initialization requires an absent database and an existing data directory. Existing files are never overwritten; review any failed reservation.',cause);
 }
}
module.exports={databasePath,openExistingDatabase,initializeDatabase};
