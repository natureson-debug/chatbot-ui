const http = require("http");
const fs = require("fs");
const path = require("path");
const { getChats, createChat, getMessages, db, findUserByUsername, createUser, createMessage, clearChatMessages, 
    deleteChat, renameChat: renameChatInDb, updateChatScrollTop, getUserSettings, saveUserSettings,
    getChatHistorySnapshot, withWriteTransaction, ChatRevisionConflictError } = require("./db");
const { getSessionToken, getSessionUser, verifyPassword, hashPassword, createSession, deleteSession } =
    require("./auth");

const {
    HOST, PORT, LLAMA_URL, LLAMA_BIND_HOST, LLAMA_PORT, AI_CONFIG_FILE, MODELS_DIR
} = require("./core/config");
const PUBLIC_DIR = path.join(__dirname, "public");

const { createChatCompletion, getHealth, getReportedModel } = require("./core/llama-client");

const { getLlamaServerPid } = require("./core/llama-runtime");

const { getAdminTelemetry } = require("./core/admin-telemetry");
const { blockedActivation } = require("./core/ai-activation");
const { createRequestTracker } = require("./core/request-tracker");
const { withHttpErrorBoundary } = require("./core/http-error-boundary");

const requestTracker = createRequestTracker();

const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
};

function serveFile(res, filePath) {
    return new Promise((resolve, reject) => {
        try {
            fs.readFile(filePath, (error, data) => {
                try {
                    if (res.destroyed || res.writableEnded) {
                        resolve();
                        return;
                    }

                    if (error) {
                        res.writeHead(404, {
                            "Content-Type": "text/plain; charset=utf-8"
                        });
                        res.end("Not found");
                    } else {
                        const ext = path.extname(filePath).toLowerCase();

                        res.writeHead(200, {
                            "Content-Type":
                                contentTypes[ext] ||
                                "application/octet-stream"
                        });

                        res.end(data);
                    }

                    resolve();
                } catch (callbackError) {
                    reject(callbackError);
                }
            });
        } catch (readError) {
            reject(readError);
        }
    });
}

function getAuthenticatedUser(req) {
    const token = getSessionToken(req);

    if (!token) {
        return null;
    }

    return getSessionUser(db, token);
}

const server = http.createServer(
    withHttpErrorBoundary(
        requestTracker.track(async (req, res) => {

    // Health check
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
            status: "ok",
            backend: "chatbot-ui",
            llama: `${LLAMA_BIND_HOST}:${LLAMA_PORT}`
        }));

        return;
    }

// List chats belonging to the authenticated user
if (req.method === "GET" && req.url === "/api/chats") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    const chats = getChats(user.id);

    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(chats));
    return;
}

// Authenticated AI runtime information
if (req.method === "GET" && req.url === "/api/ai/runtime") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({
            error: "Authentication required"
        }));
        return;
    }

    try {
        const config = JSON.parse(
            fs.readFileSync(AI_CONFIG_FILE, "utf8")
        );

        const contextLimit =
            Math.floor(config.contextSize / config.parallel);

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify({
            contextLimit,
            modelName: typeof config.model === "string"
                ? path.basename(config.model).replace(/\.gguf$/i, "")
                : null
        }));

    } catch (error) {
        console.error(
            "Failed to read AI runtime information:",
            error
        );

        res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
            error: "Failed to read AI runtime information"
        }));
    }

    return;
}

// Authenticated user settings
if (req.method === "GET" && req.url === "/api/settings") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({
            error: "Authentication required"
        }));
        return;
    }

    try {
        const settings = getUserSettings(user.id);

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify(settings));
    } catch (error) {
        console.error("Failed to load user settings:");

        res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
            error: "Failed to load user settings"
        }));
    }

    return;
}

// Authenticated user settings update
if (req.method === "POST" && req.url === "/api/settings") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({
            error: "Authentication required"
        }));
        return;
    }

    try {
        let body = "";

        for await (const chunk of req) {
            body += chunk;

            if (body.length > 16384) {
                res.writeHead(413, {
                    "Content-Type": "application/json; charset=utf-8"
                });
                res.end(JSON.stringify({
                    error: "Request too large"
                }));
                return;
            }
        }

        const settings = JSON.parse(body);

        saveUserSettings(user.id, settings);

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify({
            message: "Settings saved successfully"
        }));

    } catch (error) {
        console.error("Failed to save user settings:");

        res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
            error: "Invalid settings"
        }));
    }

    return;
}

// Create a chat for the authenticated user
if (req.method === "POST" && req.url === "/api/chats") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    const chatId = `chat-${require("node:crypto").randomUUID()}`;

    createChat(chatId, "New Chat", user.id);

    res.writeHead(201, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({
        id: chatId,
        title: "New Chat",
        revision: 0
    }));
    return;
}

// List messages in a chat owned by the authenticated user
if (req.method === "GET" && req.url.startsWith("/api/chats/")) {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    const match = /^\/api\/chats\/([^/?]+)\/messages$/.exec(req.url);

    if (!match) {
        res.writeHead(404, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
    }

    const chatId = decodeURIComponent(match[1]);
    const chat = db.prepare(`
        SELECT id FROM chats
        WHERE id = ? AND user_id = ?
    `).get(chatId, user.id);

    if (!chat) {
        res.writeHead(404, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: "Chat not found" }));
        return;
    }

    const snapshot = getChatHistorySnapshot(chatId, user.id);

    res.setHeader("X-Chat-Revision", String(snapshot.revision));
    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(snapshot.messages));
    return;
}

// Save a message to a chat owned by the authenticated user
if (req.method === "POST" && /^\/api\/chats\/[^/?]+\/messages$/.test(req.url)) {
    try {
    const originalSessionToken = getSessionToken(req);
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

        const match = /^\/api\/chats\/([^/?]+)\/messages$/.exec(req.url);
        const chatId = decodeURIComponent(match[1]);

        let body = "";
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 1_000_000) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Message too large" }));
                return;
            }
        }

        let payload;
        try {
            payload = JSON.parse(body);
        } catch (_) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid message request" }));
            return;
        }
        const { role, content, telemetry = null, displayContent = null, expectedRevision } = payload || {};
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                error: "A nonnegative safe integer expectedRevision is required",
                code: expectedRevision === undefined ? "EXPECTED_REVISION_REQUIRED" : "INVALID_REVISION"
            }));
            return;
        }

        if (
    !["user", "assistant"].includes(role) ||
    typeof content !== "string" ||
    (displayContent !== null && typeof displayContent !== "string") ||
    (telemetry !== null &&
        (typeof telemetry !== "object" || Array.isArray(telemetry)))
) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid message" }));
    return;
}

        // Body parsing is complete. All final checks and insertion share this transaction.
        const result = withWriteTransaction(() => {
        const currentUser = getSessionUser(db, originalSessionToken);
        if (!currentUser || currentUser.id !== user.id) {
            return { status: 401, body: { error: "Authentication required" } };
        }

        const chat = db.prepare(`
            SELECT id FROM chats WHERE id = ? AND user_id = ?
        `).get(chatId, user.id);

        if (!chat) {
            return { status: 404, body: { error: "Chat not found" } };
        }

        const messageId = createMessage(
            chatId, role, content, telemetry, user.id, displayContent, expectedRevision
        );
        return { status: 201, body: { id: String(messageId) } };
        });

        res.writeHead(result.status, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify(result.body));
        return;
    } catch (error) {
        if (error instanceof ChatRevisionConflictError) {
            res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({
                error: "Conversation was cleared; reload before sending.",
                code: "CHAT_REVISION_CONFLICT",
                currentRevision: error.currentRevision
            }));
            return;
        }
        console.error("Message save failed:");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Could not save message" }));
        return;
    }
}

// Clear messages from a chat owned by the authenticated user
if (req.method === "DELETE" && /^\/api\/chats\/[^/?]+\/messages$/.test(req.url)) {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    try {
        const match = /^\/api\/chats\/([^/?]+)\/messages$/.exec(req.url);
        const chatId = decodeURIComponent(match[1]);

        const chat = db.prepare(`
            SELECT id FROM chats WHERE id = ? AND user_id = ?
        `).get(chatId, user.id);

        if (!chat) {
            res.writeHead(404, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store"
            });
            res.end(JSON.stringify({ error: "Chat not found" }));
            return;
        }

        const result = clearChatMessages(chatId, user.id);

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify(result));
        return;
    } catch (error) {
        console.error("Clear chat failed:");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid clear chat request" }));
        return;
    }
}

// Delete a chat owned by the authenticated user
if (req.method === "DELETE" && /^\/api\/chats\/[^/?]+$/.test(req.url)) {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    try {
        const match = /^\/api\/chats\/([^/?]+)$/.exec(req.url);
        const chatId = decodeURIComponent(match[1]);

        const deletedChats = deleteChat(chatId, user.id);

        if (deletedChats === 0) {
            res.writeHead(404, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store"
            });
            res.end(JSON.stringify({ error: "Chat not found" }));
            return;
        }

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ deletedChats }));
        return;
    } catch (error) {
        console.error("Delete chat failed:");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid delete chat request" }));
        return;
    }
}

// Rename a chat owned by the authenticated user
if (req.method === "PATCH" && /^\/api\/chats\/[^/?]+$/.test(req.url)) {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    try {
        const match = /^\/api\/chats\/([^/?]+)$/.exec(req.url);
        const chatId = decodeURIComponent(match[1]);

        let body = "";
        for await (const chunk of req) {
            body += chunk;

            if (body.length > 1000) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request too large" }));
                return;
            }
        }

        const { title } = JSON.parse(body);

        if (
            typeof title !== "string" ||
            !title.trim() ||
            title.length > 100
        ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid chat title" }));
            return;
        }

        const updatedChats = renameChatInDb(chatId, title, user.id);

        if (updatedChats === 0) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Chat not found" }));
            return;
        }

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ title: title.trim() }));
        return;
    } catch (error) {
        console.error("Rename chat failed:");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid rename request" }));
        return;
    }
}

// Save the scroll position of a chat owned by the authenticated user
if (req.method === "PATCH" && /^\/api\/chats\/[^/?]+\/scroll$/.test(req.url)) {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    try {
        const match = /^\/api\/chats\/([^/?]+)\/scroll$/.exec(req.url);
        const chatId = decodeURIComponent(match[1]);

        let body = "";
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 1000) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request too large" }));
                return;
            }
        }

        const { scrollTop } = JSON.parse(body);

        if (!Number.isSafeInteger(scrollTop) || scrollTop < 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid scroll position" }));
            return;
        }

        const updatedChats = updateChatScrollTop(chatId, scrollTop, user.id);

        if (updatedChats === 0) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Chat not found" }));
            return;
        }

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ scrollTop }));
        return;
    } catch (error) {
        console.error("Save chat scroll position failed:");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid scroll request" }));
        return;
    }
}

    // Streaming chat proxy
    if (req.method === "POST" && req.url === "/api/chat") {
        
            const user = getAuthenticatedUser(req);

            if (!user) {
                res.writeHead(401, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store"
                });

                res.end(JSON.stringify({
                error: "Authentication required"
            }));

                return;
        }

        try {
            let body = "";

            for await (const chunk of req) {
                body += chunk;
            }

            const clientRequest = JSON.parse(body);

            if (!Array.isArray(clientRequest.messages)) {
                res.writeHead(400, {
                    "Content-Type": "application/json"
                });

                res.end(JSON.stringify({
                    error: "messages must be an array"
                }));

                return;
            }

            const aiConfig = JSON.parse(
                fs.readFileSync(AI_CONFIG_FILE, "utf8")
            );
            const availableModels = fs.readdirSync(MODELS_DIR)
                .filter(file => file.toLowerCase().endsWith(".gguf"));

            if (
                !aiConfig ||
                typeof aiConfig.model !== "string" ||
                !availableModels.includes(aiConfig.model)
            ) {
                throw new Error("Invalid AI model");
            }

            const llamaRequest = {
                model: path.join(MODELS_DIR, aiConfig.model),
                messages: clientRequest.messages,
                temperature: clientRequest.temperature ?? 0.7,
                max_tokens: clientRequest.max_tokens ?? 512,
                stream: true,

                chat_template_kwargs: {
                    enable_thinking:
                        clientRequest.enable_thinking ?? false
                }
            };

            const controller = new AbortController();

            const onDisconnect = () => {
                if (!res.writableFinished) {
                    controller.abort();
                }
            };

            res.on("close", onDisconnect);

            try {
                const upstream = await createChatCompletion(llamaRequest, {
                    signal: controller.signal
                });

                if (!upstream.ok) {
                    await upstream.body?.cancel();
                    const errorText = "Inference service rejected the request";

                    if (!res.destroyed) {
                        res.writeHead(upstream.status, {
                            "Content-Type": "text/plain"
                        });
                        res.end(errorText);
                    }
                    return;
                }

                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive"
                });

                const reader = upstream.body.getReader();

                while (true) {
                    const { done, value } = await reader.read();

                    if (done) break;
                    if (res.destroyed) break;

                    res.write(Buffer.from(value));
                }

                if (!res.destroyed) {
                    res.end();
                }

            } catch (error) {
                if (!controller.signal.aborted) {
                    console.error("INFERENCE_REQUEST_FAILED");

                    if (!res.destroyed) {
                        if (!res.headersSent) {
                            res.writeHead(500, {
                                "Content-Type": "application/json"
                            });
                        }

                        res.end(JSON.stringify({
                            error: "Inference service unavailable"
                        }));
                    }
                }
            } finally {
                res.off("close", onDisconnect);
            }

        } catch (error) {
            console.error("INFERENCE_REQUEST_FAILED");

            if (!res.headersSent) {
                res.writeHead(500, {
                    "Content-Type": "application/json"
                });
            }

            res.end(JSON.stringify({
                error: "Inference service unavailable"
            }));
        }

        return;
    }

// Return the currently authenticated user
if (req.method === "GET" && req.url === "/api/me") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
            error: "Authentication required"
        }));

        return;
    }

    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
    });

    res.end(JSON.stringify({
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin === 1
    }));

    return;
}

// Log in with an existing account
if (req.method === "POST" && req.url === "/api/login") {
    try {
        let body = "";

        for await (const chunk of req) {
            body += chunk;

            if (body.length > 4096) {
                res.writeHead(413);
                res.end("Request too large");
                return;
            }
        }

        let credentials;

        try {
            credentials = JSON.parse(body);
        } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
            return;
        }

        const { username, password } = credentials ?? {};

        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            username.length > 100 ||
            password.length > 1024
        ) {
            res.writeHead(400);
            res.end("Invalid credentials format");
            return;
        }

        const user = findUserByUsername(username);
        const validPassword = user
            ? verifyPassword(password, user.password_hash)
            : false;

        if (!validPassword) {
            res.writeHead(401, {
                "Content-Type": "application/json; charset=utf-8"
            });
            res.end(JSON.stringify({ error: "Invalid username or password" }));
            return;
        }

        const token = createSession(db, user.id);

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Set-Cookie": `chatbot_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify({
            username: user.username,
            isAdmin: user.is_admin === 1
        }));
    } catch (error) {
        console.error("Login failed:");

        if (!res.headersSent) {
            res.writeHead(500);
        }

        res.end("Login failed");
    }

    return;
}

// Log out and revoke the current session
if (req.method === "POST" && req.url === "/api/logout") {
    const token = getSessionToken(req);

    if (!token || !getSessionUser(db, token)) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    deleteSession(db, token);

    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "chatbot_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify({ message: "Logged out" }));
    return;
}

// Administrator-only password reset
if (req.method === "POST" && req.url === "/api/admin/reset-password") {
    const admin = getAuthenticatedUser(req);

    if (!admin) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    try {
        let body = "";

        for await (const chunk of req) {
            body += chunk;

            if (body.length > 8192) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request too large" }));
                return;
            }
        }

        const { userId, newPassword } = JSON.parse(body);

        if (typeof userId !== "string" || !userId ||
            typeof newPassword !== "string" || newPassword.length < 12) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                error: "Valid user ID and password of at least 12 characters required"
            }));
            return;
        }

        const passwordHash = hashPassword(newPassword);

        db.exec("BEGIN");

let updated = false;

try {
    const result = db.prepare(`
        UPDATE users SET password_hash = ? WHERE id = ?
    `).run(passwordHash, userId);

    if (result.changes > 0) {
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        updated = true;
    }

    db.exec("COMMIT");
} catch (error) {
    db.exec("ROLLBACK");
    throw error;
}

        if (!updated) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "User not found" }));
            return;
        }

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ message: "Password reset successfully" }));
    } catch (error) {
        console.error("Password reset failed:");
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unable to reset password" }));
    }

    return;
}

// Administrator-only user deletion
if (req.method === "DELETE" && req.url.startsWith("/api/admin/users/")) {
    const admin = getAuthenticatedUser(req);

    if (!admin) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    const userId = req.url.slice("/api/admin/users/".length);

    if (!userId || userId.includes("/") || userId.includes("?")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid user ID" }));
        return;
    }

    if (userId === admin.id) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "You cannot delete your own account" }));
        return;
    }

    let transactionStarted = false;

    try {
        db.exec("BEGIN IMMEDIATE");
        transactionStarted = true;

        const target = db.prepare(
            "SELECT is_admin FROM users WHERE id = ?"
        ).get(userId);

        if (!target) {
            db.exec("ROLLBACK");
            transactionStarted = false;

            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "User not found" }));
            return;
        }

        if (target.is_admin === 1) {
            const adminCount = db.prepare(
                "SELECT COUNT(*) AS count FROM users WHERE is_admin = 1"
            ).get().count;

            if (adminCount <= 1) {
                db.exec("ROLLBACK");
                transactionStarted = false;

                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    error: "Cannot delete the last administrator"
                }));
                return;
            }
        }

        // Delete messages first, then their chats.
        db.prepare(`
            DELETE FROM messages
            WHERE chat_id IN (
                SELECT id FROM chats WHERE user_id = ?
            )
        `).run(userId);

        db.prepare("DELETE FROM chats WHERE user_id = ?").run(userId);

        // Sessions are also deleted by the database's ON DELETE CASCADE.
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);

        db.exec("COMMIT");
        transactionStarted = false;

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({ message: "User deleted successfully" }));

    } catch (error) {
        if (transactionStarted) {
            try {
                db.exec("ROLLBACK");
            } catch (rollbackError) {
                console.error("Rollback failed:");
            }
        }

        console.error("User deletion failed:");

        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unable to delete user" }));
    }

    return;
}

// Administrator-only user creation
if (req.method === "POST" && req.url === "/api/admin/users") {
    const admin = getAuthenticatedUser(req);

    if (!admin) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    try {
        let body = "";

        for await (const chunk of req) {
            body += chunk;

            if (body.length > 8192) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request too large" }));
                return;
            }
        }

        const { username, password, role } = JSON.parse(body);

if (role !== "user" && role !== "admin") {
    res.writeHead(400, {
        "Content-Type": "application/json; charset=utf-8"
    });
    res.end(JSON.stringify({ error: "Invalid account type" }));
    return;
}

const isAdmin = role === "admin";
const id = createUser(username, password, isAdmin);

        res.writeHead(201, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({
    id,
    username: username.trim(),
    is_admin: isAdmin ? 1 : 0
}));
    } catch (error) {
        const duplicateUsername =
            error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
            error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
            (error.code === "ERR_SQLITE_ERROR" &&
             /UNIQUE constraint failed: users\.username/.test(error.message));

        const status = duplicateUsername ? 409 : 400;

        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });
        res.end(JSON.stringify({
            error: duplicateUsername
                ? "Username already exists"
                : "Invalid user details or password (minimum 12 characters)"
        }));
    }

    return;
}

// Administrator-only user list
if (req.method === "GET" && req.url === "/api/admin/users") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (user.is_admin !== 1) {
        res.writeHead(403, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    const users = db.prepare(`
        SELECT id, username, is_admin
        FROM users
        ORDER BY username COLLATE NOCASE
    `).all();

    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(users));
    return;
}

// Read-only telemetry; authorize before collecting or serving cached observations.
if (req.method === "GET" && ["/api/admin/ai/telemetry", "/api/admin/ai/telemetry/status"].includes(req.url)) {
    const token = getSessionToken(req);
    const admin = getAuthenticatedUser(req);
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (!admin || admin.is_admin !== 1) {
        res.writeHead(admin ? 403 : 401, headers);
        res.end(JSON.stringify({ error: "Administrator access required" })); return;
    }
    const sample = await getAdminTelemetry();
    const current = getSessionUser(db, token);
    if (!current || current.id !== admin.id || current.is_admin !== 1) {
        res.writeHead(401, headers); res.end(JSON.stringify({ error: "Session no longer authorized" })); return;
    }
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, headers);
    res.end(JSON.stringify(req.url.endsWith("/status") ? { sampledAt: sample.sampledAt, backend: sample.backend, gpuState: sample.gpu.state } : sample));
    return;
}

// Administrator-only AI server status
if (req.method === "GET" && req.url === "/api/admin/ai/status") {
    const admin = getAuthenticatedUser(req);

    if (!admin) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        res.writeHead(403, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    let configuredModel = null;
    let runningModel = null;
    try {
        const config = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, "utf8"));
        if (typeof config.model === "string") configuredModel = config.model;
    } catch (_) { /* Unknown configuration must remain unknown. */ }
    try { runningModel = await getReportedModel(); } catch (_) { /* Observation unavailable. */ }
    const modelState = {
        configuredModel, runningModel,
        pendingModelChange: configuredModel && runningModel ? path.join(MODELS_DIR, configuredModel) !== runningModel : null,
        activation: blockedActivation()
    };
    try {
        const health = await getHealth({ signal: AbortSignal.timeout(3000) });

        const pid = await getLlamaServerPid();

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify({
            ...modelState,
            running: health.status === "ok",
            status: health.status,
            pid
        }));

    } catch (error) {
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify({
            ...modelState,
            running: false,
            status: "unavailable",
            pid: null
        }));
    }

    return;
}

// Administrator-only AI server restart
if (req.method === "POST" && req.url === "/api/admin/ai/restart") {
    const admin = getAuthenticatedUser(req);

    if (!admin) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        res.writeHead(403, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    if (!require("./core/restart-request").validRestartRequest(req)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ state: "blocked", code: "RESTART_ORIGIN_REJECTED", error: "Same-origin administrator confirmation required." }));
        return;
    }
    // No qualified owner is connected. Do not invoke legacy tasks or adopt a PID.
    console.info(JSON.stringify({ event: "ai-restart", outcome: "blocked", code: "LIFECYCLE_ACTIVATION_DISABLED" }));
    res.writeHead(503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(blockedActivation()));

    return;
}

// Administrator-only AI configuration
if (req.method === "GET" && req.url === "/api/admin/ai/config") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (user.is_admin !== 1) {
        res.writeHead(403, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    try {
        const config = JSON.parse(
            fs.readFileSync(AI_CONFIG_FILE, "utf8")
        );

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify(require("./core/ai-settings").validateAiSettings(config)));
    } catch (error) {
        console.error("Failed to read AI configuration:");

        res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
            error: "Failed to read AI configuration"
        }));
    }

    return;
}

// Administrator-only AI configuration update
if (req.method === "POST" && req.url === "/api/admin/ai/config") {
    const admin = getAuthenticatedUser(req);

    if (!admin) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        res.writeHead(403, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    try {
        let body = "";

        for await (const chunk of req) {
            body += chunk;

            if (body.length > 8192) {
                res.writeHead(413, {
                    "Content-Type": "application/json; charset=utf-8"
                });
                res.end(JSON.stringify({ error: "Request too large" }));
                return;
            }
        }

        const payload = JSON.parse(body);
        const { model, parallel, contextSize } = payload;

        // Validate model against GGUF files actually installed.
        const availableModels = fs.readdirSync(MODELS_DIR)
            .filter(file => file.toLowerCase().endsWith(".gguf"));

        if (
            typeof model !== "string" ||
            !availableModels.includes(model)
        ) {
            res.writeHead(400, {
                "Content-Type": "application/json; charset=utf-8"
            });
            res.end(JSON.stringify({ error: "Invalid AI model" }));
            return;
        }

        if (
            !Number.isInteger(parallel) ||
            parallel < 1 ||
            parallel > 8
        ) {
            res.writeHead(400, {
                "Content-Type": "application/json; charset=utf-8"
            });
            res.end(JSON.stringify({ error: "Invalid parallel slot count" }));
            return;
        }

        if (
            !Number.isInteger(contextSize) ||
            contextSize < 1024 ||
            contextSize > 131072 ||
            contextSize % 1024 !== 0
        ) {
            res.writeHead(400, {
                "Content-Type": "application/json; charset=utf-8"
            });
            res.end(JSON.stringify({ error: "Invalid context size" }));
            return;
        }

        const previous = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, "utf8"));
        const additions = {};
        for (const key of ["gpuLayers", "device", "verbosity"]) {
            if (Object.hasOwn(payload, key)) additions[key] = payload[key];
        }
        let config;
        try {
            const { validateAiSettings } = require("./core/ai-settings");
            if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw Error("Invalid AI configuration");
            config = validateAiSettings({ ...previous, model, parallel, contextSize, ...additions });
        } catch (error) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: error.message }));
            return;
        }

        // Replace only after a complete validated write; a failed write keeps the old file.
        const temporaryConfig = AI_CONFIG_FILE + "." + require("node:crypto").randomUUID() + ".tmp";
        try {
            fs.writeFileSync(temporaryConfig, JSON.stringify(config, null, 4) + "\n", { encoding: "utf8", flag: "wx" });
            fs.renameSync(temporaryConfig, AI_CONFIG_FILE);
        } finally {
            if (fs.existsSync(temporaryConfig)) fs.unlinkSync(temporaryConfig);
        }

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify({
            message: "AI configuration saved",
            config
        }));

    } catch (error) {
        console.error("Failed to save AI configuration:");

        res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
            error: "Failed to save AI configuration"
        }));
    }

    return;
}

// Administrator-only AI model list
if (req.method === "GET" && req.url === "/api/admin/ai/models") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (user.is_admin !== 1) {
        res.writeHead(403, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Administrator access required" }));
        return;
    }

    try {
        const models = fs.readdirSync(MODELS_DIR)
            .filter(file => file.toLowerCase().endsWith(".gguf"))
            .sort((a, b) => a.localeCompare(b));

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify(models));
    } catch (error) {
        console.error("Failed to read AI models directory:");

        res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
            error: "Failed to read AI models directory"
        }));
    }

    return;
}

// Administrator-only console page
if (req.method === "GET" && req.url === "/admin") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        res.writeHead(401);
        res.end("Authentication required");
        return;
    }

    if (user.is_admin !== 1) {
        res.writeHead(403);
        res.end("Administrator access required");
        return;
    }

    await serveFile(res, path.join(PUBLIC_DIR, "admin.html"));
    return;
}

    // Static browser files
    if (req.method === "GET") {

        // Prevent direct access to the Admin Console file
        if (req.url.split("?")[0].replace(/\\/g, "/").toLowerCase().replace(/\/+/g, "/") === "/admin.html") {
            res.writeHead(404);
            res.end("Not found");
            return;
        }

        let requestedPath =
            req.url === "/" ? "/index.html" : req.url;

        requestedPath = requestedPath.split("?")[0];

        const safePath = path.normalize(requestedPath)
            .replace(/^(\.\.[/\\])+/, "");

        const filePath = path.join(PUBLIC_DIR, safePath);

        if (path.relative(PUBLIC_DIR, filePath).startsWith("..") ||
            path.isAbsolute(path.relative(PUBLIC_DIR, filePath)) ||
            path.basename(filePath).toLowerCase().replace(/[. ]+$/, "") === "admin.html" ||
            /[:\x00]/.test(requestedPath) || /%/.test(requestedPath)) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        await serveFile(res, filePath);
        return;
    }

    res.writeHead(404, {
        "Content-Type": "text/plain"
    });

    res.end("Not found");
        })
    )
);

server.listen(PORT, HOST, () => {
    require("./core/application-lifecycle").installApplicationLifecycle({ server, requestTracker, db });
    console.log("");
    console.log("Local AI Chatbot");
    console.log("----------------");
    console.log(`UI:    http://${HOST}:${PORT}`);
    console.log(`Llama: ${LLAMA_URL}`);
    console.log("");
});
