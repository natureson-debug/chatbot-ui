'use strict';
// Additive migration image_attachments-v1; no legacy records are rewritten.
function migrate(db){db.exec(`CREATE TABLE IF NOT EXISTS image_attachments (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT, message_id INTEGER UNIQUE,
 storage_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes>0), width INTEGER NOT NULL, height INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('uploading','pending','bound','deleting')),
 FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE SET NULL,
 FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE SET NULL);
 CREATE INDEX IF NOT EXISTS image_attachments_owner ON image_attachments(user_id,state);
 CREATE INDEX IF NOT EXISTS image_attachments_cleanup ON image_attachments(state,expires_at);`);}
module.exports={migrate};
