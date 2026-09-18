const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const dbPath = path.join(__dirname, "data", "chatbot.db");
const db = new DatabaseSync(dbPath);

const { randomUUID } = require("node:crypto");
const { hashPassword } = require("./auth");

db.exec("PRAGMA foreign_keys = ON;");

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

`);

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

function getChats() {
    return db.prepare(`
        SELECT id, title, scroll_top
        FROM chats
        ORDER BY rowid
    `).all();
}

function createChat(id, title, userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    db.prepare(`
        INSERT INTO chats (id, title, user_id)
        VALUES (?, ?, ?)
    `).run(id, title, userId);
}

function createMessage(chatId, role, content, telemetry = null) {
    const result = db.prepare(`
        INSERT INTO messages (
            chat_id,
            role,
            content,
            telemetry_json
        )
        VALUES (?, ?, ?, ?)
    `).run(
        chatId,
        role,
        content,
        telemetry === null
            ? null
            : JSON.stringify(telemetry)
    );

    return result.lastInsertRowid;
}

function getMessages(chatId) {
    const rows = db.prepare(`
        SELECT id, role, content, telemetry_json
        FROM messages
        WHERE chat_id = ?
        ORDER BY id ASC
    `).all(chatId);

    return rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        telemetry: row.telemetry_json === null
            ? null
            : JSON.parse(row.telemetry_json)
    }));
}

function createUser(username, password, isAdmin = false) {
    if (typeof username !== "string" || !username.trim()) {
        throw new Error("Username is required");
    }

    if (typeof password !== "string" || password.length < 12) {
        throw new Error("Password must contain at least 12 characters");
    }

    const id = randomUUID();
    const passwordHash = hashPassword(password);

    db.prepare(`
        INSERT INTO users (id, username, password_hash, is_admin)
        VALUES (?, ?, ?, ?)
    `).run(id, username.trim(), passwordHash, isAdmin ? 1 : 0);

    return id;
}

function findUserByUsername(username) {
    return db.prepare(`
        SELECT id, username, password_hash, is_admin
        FROM users
        WHERE username = ?
    `).get(username);
}

module.exports = {
    db,
    getChats,
    createChat,
    createMessage,
    getMessages,
    createUser,
    findUserByUsername
};