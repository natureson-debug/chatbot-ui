const { scryptSync, randomBytes, timingSafeEqual, createHash } = require("node:crypto");

function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);

    return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
    const [algorithm, saltHex, hashHex] = storedHash.split(":");

    if (algorithm !== "scrypt" || !saltHex || !hashHex) {
        return false;
    }

    const expectedHash = Buffer.from(hashHex, "hex");
    const actualHash = scryptSync(
        password,
        Buffer.from(saltHex, "hex"),
        expectedHash.length
    );

    return timingSafeEqual(actualHash, expectedHash);
}

function createSession(db, userId) {
    const token = randomBytes(32).toString("hex");

    const tokenHash = createHash("sha256")
        .update(token)
        .digest("hex");

    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    db.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at)
        VALUES (?, ?, ?)
    `).run(tokenHash, userId, expiresAt);

    return token;
}

function getSessionUser(db, token) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        return null;
    }

    const tokenHash = createHash("sha256")
        .update(token)
        .digest("hex");

    const user = db.prepare(`
        SELECT u.id, u.username, u.is_admin
        FROM sessions AS s
        JOIN users AS u ON u.id = s.user_id
        WHERE s.token_hash = ?
          AND s.expires_at > ?
    `).get(tokenHash, Date.now());

    return user ?? null;
}

function deleteSession(db, token) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
        return false;
    }

    const tokenHash = createHash("sha256")
        .update(token)
        .digest("hex");

    const result = db.prepare(`
        DELETE FROM sessions
        WHERE token_hash = ?
    `).run(tokenHash);

    return result.changes === 1;
}

function getSessionToken(req) {
    const cookieHeader = req.headers.cookie;

    if (typeof cookieHeader !== "string") {
        return null;
    }

    const sessionCookie = cookieHeader
        .split(";")
        .map((cookie) => cookie.trim())
        .find((cookie) => cookie.startsWith("chatbot_session="));

    if (!sessionCookie) {
        return null;
    }

    return sessionCookie.slice("chatbot_session=".length) || null;
}

module.exports = {
    hashPassword,
    verifyPassword,
    createSession,
    getSessionUser,
    getSessionToken,
    deleteSession
};