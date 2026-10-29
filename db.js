const { openExistingDatabase, databasePath } = require("./core/database-startup");

const dbPath = databasePath(__dirname);
const db = openExistingDatabase(dbPath);

const { randomUUID } = require("node:crypto");
const { hashPassword } = require("./auth");


function validateRevision(revision) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError("A nonnegative safe integer revision is required");
    }
}

class ChatRevisionConflictError extends Error {
    constructor(currentRevision) {
        super("Chat revision conflict");
        this.name = "ChatRevisionConflictError";
        this.code = "CHAT_REVISION_CONFLICT";
        this.currentRevision = currentRevision;
    }
}

// Callbacks must be synchronous. Nested calls use savepoints so an API layer
// can enclose final session validation and createMessage in one write transaction.
function withWriteTransaction(callback) {
    if (typeof callback !== "function" || callback.constructor.name === "AsyncFunction") {
        throw new TypeError("A synchronous transaction callback is required");
    }
    const nested = db.isTransaction;
    db.exec(nested ? "SAVEPOINT chatbot_write" : "BEGIN IMMEDIATE");
    try {
        const result = callback();
        if (result && typeof result.then === "function") {
            throw new TypeError("Transaction callbacks must not return promises");
        }
        db.exec(nested ? "RELEASE chatbot_write" : "COMMIT");
        return result;
    } catch (error) {
        db.exec(nested ? "ROLLBACK TO chatbot_write; RELEASE chatbot_write" : "ROLLBACK");
        throw error;
    }
}

function getChats(userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    return db.prepare(`
        SELECT id, title, scroll_top, revision
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

function createMessage(chatId, role, content, telemetry = null, userId, displayContent = null, expectedRevision) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A message owner is required");
    }

    validateRevision(expectedRevision);
    return withWriteTransaction(() => {
    const chat = db.prepare(`
        SELECT id, revision FROM chats
        WHERE id = ? AND user_id = ?
    `).get(chatId, userId);

    if (!chat) {
        throw new Error("Chat not found");
    }
    validateRevision(chat.revision);
    if (chat.revision !== expectedRevision) {
        throw new ChatRevisionConflictError(chat.revision);
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
    });
}

function clearChatMessages(chatId, userId) {
    if (typeof userId !== "string" || !userId.trim()) {
        throw new Error("A chat owner is required");
    }

    return withWriteTransaction(() => {
        const chat = db.prepare("SELECT revision FROM chats WHERE id = ? AND user_id = ?")
            .get(chatId, userId);
        if (!chat) throw new Error("Chat not found");
        validateRevision(chat.revision);
        if (chat.revision === Number.MAX_SAFE_INTEGER) throw new RangeError("Chat revision overflow");
        const result = db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
        const revision = chat.revision + 1;
        db.prepare("UPDATE chats SET revision = ? WHERE id = ? AND user_id = ?")
            .run(revision, chatId, userId);
        return { deletedMessages: result.changes, revision };
    });
}

function getChatHistorySnapshot(chatId, userId) {
    if (typeof userId !== "string" || !userId.trim()) throw new Error("A chat owner is required");
    // One statement supplies a consistent snapshot, including empty chats.
    const rows = db.prepare(`
        SELECT c.revision, m.id, m.role, m.content, m.display_content, m.telemetry_json
        FROM chats AS c LEFT JOIN messages AS m ON m.chat_id = c.id
        WHERE c.id = ? AND c.user_id = ? ORDER BY m.id ASC
    `).all(chatId, userId);
    if (!rows.length) throw new Error("Chat not found");
    validateRevision(rows[0].revision);
    return {
        revision: rows[0].revision,
        messages: rows.filter((row) => row.id !== null).map((row) => ({
            id: row.id, role: row.role, content: row.content,
            displayContent: row.display_content,
            telemetry: row.telemetry_json === null ? null : JSON.parse(row.telemetry_json)
        }))
    };
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
        SELECT system_prompt, temperature, max_tokens, thinking, theme
        FROM user_settings
        WHERE user_id = ?
    `).get(userId);

    if (!settings) {
        db.prepare(`
            INSERT INTO user_settings (user_id)
            VALUES (?)
        `).run(userId);

        settings = db.prepare(`
            SELECT system_prompt, temperature, max_tokens, thinking, theme
            FROM user_settings
            WHERE user_id = ?
        `).get(userId);
    }

    return {
        systemPrompt: settings.system_prompt,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        thinking: settings.thinking === 1,
        theme: settings.theme
    };
}


function saveUserSettings(
    userId,
    {
        systemPrompt,
        temperature,
        maxTokens,
        thinking,
        theme
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

    if (theme !== "dark" && theme !== "light") {
        throw new Error("Theme must be dark or light");
    }

    db.prepare(`
        INSERT INTO user_settings (
            user_id,
            system_prompt,
            temperature,
            max_tokens,
            thinking,
            theme
        )
        VALUES (?, ?, ?, ?, ?, ?)

        ON CONFLICT(user_id) DO UPDATE SET
            system_prompt = excluded.system_prompt,
            temperature = excluded.temperature,
            max_tokens = excluded.max_tokens,
            thinking = excluded.thinking,
            theme = excluded.theme
    `).run(
        userId,
        systemPrompt,
        temperature,
        maxTokens,
        thinking ? 1 : 0,
        theme
    );
}

module.exports = {
    db,
    withWriteTransaction,
    ChatRevisionConflictError,
    getChatHistorySnapshot,
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
