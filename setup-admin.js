const { db, createUser } = require("./db");

try {
    const username = process.env.CHATBOT_ADMIN_USERNAME;
    const password = process.env.CHATBOT_ADMIN_PASSWORD;

    if (!username || !password) {
        throw new Error("Administrator credentials were not provided");
    }

    const existingAdmin = db.prepare(`
        SELECT id FROM users WHERE is_admin = 1 LIMIT 1
    `).get();

    if (existingAdmin) {
        throw new Error("An administrator already exists");
    }

    const id = createUser(username, password, true);

    console.log("Administrator created:", username);
    console.log("User ID:", id);
} catch (error) {
    console.error("Setup failed:", error.message);
    process.exitCode = 1;
} finally {
    db.close();
}