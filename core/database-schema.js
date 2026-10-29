'use strict';
// Shared schema for explicit initialization and existing-database migrations.
function initializeSchema(db) {
 db.exec('PRAGMA foreign_keys = ON;');
 db.exec('BEGIN IMMEDIATE');
 try {

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0
        CHECK (is_admin IN (0, 1))
    );
    
    CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        scroll_top INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        telemetry_json TEXT,
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        system_prompt TEXT NOT NULL DEFAULT '',
        temperature REAL NOT NULL DEFAULT 0.7,
        max_tokens INTEGER NOT NULL DEFAULT 4096,
        thinking INTEGER NOT NULL DEFAULT 0
            CHECK (thinking IN (0, 1)),
        theme TEXT NOT NULL DEFAULT 'dark'
            CHECK (theme IN ('dark', 'light')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

`);

const userSettingsColumns = db.prepare(`
    PRAGMA table_info(user_settings)
`).all();

if (!userSettingsColumns.some((column) => column.name === "theme")) {
    db.exec(`
        ALTER TABLE user_settings
        ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'
            CHECK (theme IN ('dark', 'light'))
    `);
}

const chatColumns = db.prepare(`
    PRAGMA table_info(chats)
`).all();

if (!chatColumns.some((column) => column.name === "user_id")) {
    db.exec(`
        ALTER TABLE chats
        ADD COLUMN user_id TEXT
        REFERENCES users(id)
    `);
}

const messageColumns = db.prepare(`
    PRAGMA table_info(messages)
`).all();

if (!messageColumns.some((column) => column.name === "display_content")) {
    db.exec(`
        ALTER TABLE messages
        ADD COLUMN display_content TEXT
    `);
}

// The revision migration is atomic and must succeed before this module loads.
{
    const columns = db.prepare("PRAGMA table_info(chats)").all();
    if (!columns.some((column) => column.name === "revision")) {
        db.exec(`
            ALTER TABLE chats ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
            CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
        `);
    }
    if (db.prepare(`
        SELECT 1 FROM chats WHERE revision IS NULL OR typeof(revision) != 'integer'
            OR revision < 0 OR revision > 9007199254740991 LIMIT 1
    `).get()) {
        throw new Error("Invalid stored chat revision");
    }
}
 db.exec('COMMIT');
 } catch(error) { if(db.isTransaction)db.exec('ROLLBACK'); throw error; }
}
module.exports={initializeSchema};
