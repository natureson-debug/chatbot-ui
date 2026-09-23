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

    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        system_prompt TEXT NOT NULL DEFAULT '',
        temperature REAL NOT NULL DEFAULT 0.7,
        max_tokens INTEGER NOT NULL DEFAULT 4096,
        thinking INTEGER NOT NULL DEFAULT 0
            CHECK (thinking IN (0, 1)),
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

const messageColumns = db.prepare(`
    PRAGMA table_info(messages)
`).all();

if (!messageColumns.some((column) => column.name === "display_content")) {
    db.exec(`
        ALTER TABLE messages
        ADD COLUMN display_content TEXT
    `);
}

function getChats(userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    return db.prepare(`
        SELECT id, title, scroll_top
        FROM chats
        WHERE user_id = ?
        ORDER BY rowid
    `).all(userId);
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

function createMessage(chatId, role, content, telemetry = null, userId, displayContent = null) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A message owner is required");
    }

    const chat = db.prepare(`
        SELECT id FROM chats
        WHERE id = ? AND user_id = ?
    `).get(chatId, userId);

    if (!chat) {
        throw new Error("Chat not found");
    }
    const result = db.prepare(`
    INSERT INTO messages (
        chat_id,
        role,
        content,
        telemetry_json,
        display_content
    )
    VALUES (?, ?, ?, ?, ?)
`).run(
    chatId,
    role,
    content,
    telemetry === null
        ? null
        : JSON.stringify(telemetry),
    displayContent
);

    return result.lastInsertRowid;
}

function clearChatMessages(chatId, userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    const result = db.prepare(`
        DELETE FROM messages
        WHERE chat_id = ?
          AND EXISTS (
              SELECT 1
              FROM chats
              WHERE id = ?
                AND user_id = ?
          )
    `).run(chatId, chatId, userId);

    return result.changes;
}

function deleteChat(chatId, userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    const result = db.prepare(`
        DELETE FROM chats
        WHERE id = ? AND user_id = ?
    `).run(chatId, userId);

    return result.changes;
}

function updateChatScrollTop(chatId, scrollTop, userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    if (!Number.isSafeInteger(scrollTop) || scrollTop < 0) {
        throw new Error("Invalid scroll position");
    }

    const result = db.prepare(`
        UPDATE chats
        SET scroll_top = ?
        WHERE id = ? AND user_id = ?
    `).run(scrollTop, chatId, userId);

    return result.changes;
}

function renameChat(chatId, title, userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    if (
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 100
    ) {
        throw new Error("Invalid chat title");
    }

    const result = db.prepare(`
        UPDATE chats
        SET title = ?
        WHERE id = ? AND user_id = ?
    `).run(title.trim(), chatId, userId);

    return result.changes;
}

function getMessages(chatId, userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    const rows = db.prepare(`
        SELECT m.id, m.role, m.content, m.display_content, m.telemetry_json
        FROM messages AS m
        JOIN chats AS c ON c.id = m.chat_id
        WHERE m.chat_id = ?
          AND c.user_id = ?
        ORDER BY m.id ASC
    `).all(chatId, userId);

    return rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        displayContent: row.display_content,
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

function getUserSettings(userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A user ID is required");
    }

    let settings = db.prepare(`
        SELECT system_prompt, temperature, max_tokens, thinking
        FROM user_settings
        WHERE user_id = ?
    `).get(userId);

    if (!settings) {
        db.prepare(`
            INSERT INTO user_settings (user_id)
            VALUES (?)
        `).run(userId);

        settings = db.prepare(`
            SELECT system_prompt, temperature, max_tokens, thinking
            FROM user_settings
            WHERE user_id = ?
        `).get(userId);
    }

    return {
        systemPrompt: settings.system_prompt,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        thinking: settings.thinking === 1
    };
}


function saveUserSettings(
    userId,
    {
        systemPrompt,
        temperature,
        maxTokens,
        thinking
    }
) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A user ID is required");
    }

    if (typeof systemPrompt !== "string") {
        throw new Error("Invalid system prompt");
    }

    if (
        typeof temperature !== "number" ||
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 2
    ) {
        throw new Error("Temperature must be between 0 and 2");
    }

    if (
        !Number.isInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > 8192
    ) {
        throw new Error("Max Tokens must be between 1 and 8192");
    }

    if (typeof thinking !== "boolean") {
        throw new Error("Invalid thinking setting");
    }

    db.prepare(`
        INSERT INTO user_settings (
            user_id,
            system_prompt,
            temperature,
            max_tokens,
            thinking
        )
        VALUES (?, ?, ?, ?, ?)

        ON CONFLICT(user_id) DO UPDATE SET
            system_prompt = excluded.system_prompt,
            temperature = excluded.temperature,
            max_tokens = excluded.max_tokens,
            thinking = excluded.thinking
    `).run(
        userId,
        systemPrompt,
        temperature,
        maxTokens,
        thinking ? 1 : 0
    );
}

module.exports = {
    db,
    getChats,
    createChat,
    createMessage,
    getMessages,
    createUser,
    findUserByUsername,
    clearChatMessages,
    deleteChat,
    renameChat,
    updateChatScrollTop,
    getUserSettings,
    saveUserSettings
};