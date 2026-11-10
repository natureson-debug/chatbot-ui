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
const sessionCookie = require('./core/session-cookie').createSessionCookiePolicy(HOST);
const connections = require("./core/connections");
const providers = require("./core/provider-adapter");
const PUBLIC_DIR = path.join(__dirname, "public");

const { createChatCompletion, getHealth, getReportedModel, readTelemetryResource } = require("./core/llama-client");


const { getAdminTelemetry } = require("./core/admin-telemetry");
const { createGpuTelemetryStorage } = require("./core/gpu-telemetry-storage");
const createGpuTelemetryCache = require("./core/gpu-telemetry-cache");
const { createBackgroundTelemetryCollector } = require("./core/background-telemetry-collector");
const { createSystemLogService, validateFilters } = require("./core/system-logs");
const { createSystemLogRoute } = require("./core/system-log-routes");
const { createBenchmarkRunner } = require("./core/benchmark-runner");
const { createBenchmarkRoutes } = require("./core/benchmark-routes");
const { blockedActivation } = require("./core/ai-activation");
const { createRequestTracker } = require("./core/request-tracker");
const { withHttpErrorBoundary } = require("./core/http-error-boundary");

const requestTracker = createRequestTracker();
const systemLogs = createSystemLogService({ db });
let lastBackendHealthState = null;
const systemLogRoute = createSystemLogRoute({
    logs: systemLogs,
    validate: validateFilters,
    authenticate: req => getAuthenticatedUser(req),
    revalidate: req => getAuthenticatedUser(req)
});
const benchmarkRunner = createBenchmarkRunner({
    db,
    createChatCompletion,
    readSlots: options => readTelemetryResource('/slots', options),
    getModel: getReportedModel,
    getHardware: async () => {
        const telemetry = await getAdminTelemetry();
        return telemetry.gpu.state === 'available'
            ? { gpus: telemetry.gpu.devices.map(device => ({
                name: device.name,
                uuid: device.uuid,
                driver: device.driver
            })) }
            : null;
    }
});
const benchmarkRoute = createBenchmarkRoutes({
    runner: benchmarkRunner,
    authenticate: req => getAuthenticatedUser(req),
    revalidate: req => getAuthenticatedUser(req),
    logAdminAccessDenied
});

const gpuTelemetryCache = createGpuTelemetryCache();
const gpuTelemetryStorage = createGpuTelemetryStorage(db);
const backgroundTelemetryCollector = createBackgroundTelemetryCollector(gpuTelemetryStorage, getAdminTelemetry, gpuTelemetryCache);

function logSystemEvent(req, eventCode, fields = {}) {
    systemLogs.log(eventCode, fields);
}

function logAdminAccessDenied(req, admin) {
    logSystemEvent(req, "AUTH_ADMIN_ACCESS_DENIED", {
        actorId: admin?.id,
        metadata: {
            resource: "admin_api",
            reason: admin ? "not_administrator" : "unauthenticated"
        }
    });
}

const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
};

function buildLegacyProvider() {
    try {
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

    return {
        id: "legacy-local",
        name: "Local llama.cpp",
        adapter: "llama.cpp",
        endpoint: LLAMA_URL.replace(/\/chat\/completions$/i, ""),
        model: path.join(MODELS_DIR, aiConfig.model),
        credentialRef: "local-api-key",
        parameters: ["temperature", "max_tokens"],
        capabilities: {
            streaming: true,
            thinking: true,
            vision: false,
            tools: false,
            models: false
        },
        contextLimit: Math.floor(aiConfig.contextSize / aiConfig.parallel),
        legacy: true
    };
    } catch (error) {
        // An absent optional installation is not an application startup failure.
        // Malformed existing configuration still fails closed.
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

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

    const benchmarkPath = req.url.split("?")[0];
    if (
        benchmarkPath === "/api/admin/benchmarks" ||
        benchmarkPath.startsWith("/api/admin/benchmarks/")
    ) {
        if (await benchmarkRoute(req, res)) return;
    }
    if (systemLogRoute(req, res)) return;

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

if (req.url.startsWith('/api/attachments') || req.url.startsWith('/api/admin/extensions') || req.url === '/api/extensions') {
    const originalToken=getSessionToken(req), user=getAuthenticatedUser(req);
    if(await require('./core/extension-routes').handle(req,res,{user,revalidate:()=>{const current=getSessionUser(db,originalToken);return !!current&&current.id===user?.id&&current.is_admin===user?.is_admin;}}))return;
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
        const selected = await connections.selected();
        if (selected) {
            res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
            res.end(JSON.stringify({connectionId:selected.id,modelName:selected.model,contextLimit:selected.contextLimit,capabilities:providers.usable(selected),source:"provider-declared"}));
            return;
        }
        const registry = await connections.read();
        const legacy = registry.defaultId === 'legacy-local' ? buildLegacyProvider() : null;
        if (!legacy) {
            res.writeHead(200, {"Content-Type":"application/json", "Cache-Control":"no-store"});
            res.end(JSON.stringify({state:'configuration_required',code:'PROVIDER_CONFIGURATION_REQUIRED',
                connectionId:null,modelName:null,contextLimit:null,
                capabilities:{streaming:false,thinking:false,vision:false,tools:false,models:false}}));
            return;
        }

        const contextLimit =
            legacy.contextLimit;

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify({
            contextLimit,
            modelName: path.basename(legacy.model).replace(/\.gguf$/i, "")
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

// Authenticated catalog: only administrator-configured chat models, no secrets.
if (req.method === "GET" && req.url === "/api/ai/models") {
 const user=getAuthenticatedUser(req);if(!user){res.writeHead(401);res.end();return;}
 try{const config=await connections.read();const legacy=config.defaultId==='legacy-local'?buildLegacyProvider():null;
 if(!getAuthenticatedUser(req)){res.writeHead(401);res.end();return;}
 const catalog=require('./core/chat-models');
 const permitted=entry=>{const adapter=config.connections.find(c=>c.id===entry?.providerId)?.adapter;return !['openai-responses','deepseek-chat'].includes(adapter)||require('./core/openai-usage').forProvider(adapter==='deepseek-chat'?'deepseek':'openai').settings(db).enabled===1;};
 const defaultModel=catalog.defaultChoice(config,legacy);
 res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify({defaultId:config.defaultId,default:permitted(defaultModel)?defaultModel:null,models:catalog.choices(config,legacy).filter(permitted)}));
 }catch{res.writeHead(503);res.end(JSON.stringify({error:'Model list unavailable'}));}return;
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

        const releaseBenchmarkChat = await benchmarkRunner.beginChatRequest();
        const releaseChatAdmission = () => {
            res.off("finish", releaseChatAdmission);
            res.off("close", releaseChatAdmission);
            releaseBenchmarkChat();
        };
        res.once("finish", releaseChatAdmission);
        res.once("close", releaseChatAdmission);

        try {
            let selectedConnection = await connections.selected();
            let provider = selectedConnection;
            let body = "";

            for await (const chunk of req) {
                body += chunk;
                if (body.length > 2 * 1024 * 1024) throw Error("Request too large");
            }

            const clientRequest = JSON.parse(body);
            if (clientRequest.selection !== undefined) {
                try {
                    const registry=await connections.read();
                    provider=require('./core/chat-models').resolve(registry,clientRequest.selection,clientRequest.selection?.providerId==='legacy-local'&&registry.defaultId==='legacy-local'?buildLegacyProvider():null);
                    selectedConnection=provider.legacy?null:provider;
                } catch {res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"Selected model is unavailable; reload the model list",code:"MODEL_SELECTION_UNAVAILABLE"}));return;}
            }

            if (!provider) {
                const registry = await connections.read();
                if (registry.defaultId === 'legacy-local') provider=buildLegacyProvider();
                if (!provider) {
                    res.writeHead(503, {"Content-Type":"application/json"});
                    res.end(JSON.stringify({error:'Configure an enabled inference provider before chatting',code:'PROVIDER_CONFIGURATION_REQUIRED'}));
                    return;
                }
            }
            if(['openai-responses','deepseek-chat'].includes(provider.adapter)){
                const token=getSessionToken(req);
                await require('./core/openai-http').serve({db,req,res,user,provider,input:clientRequest,providers,authorize:()=>getSessionUser(db,token)?.id===user.id});
                return;
            }
            if (!Array.isArray(clientRequest.messages)) {
                res.writeHead(400, {
                    "Content-Type": "application/json"
                });

                res.end(JSON.stringify({
                    error: "messages must be an array"
                }));

                return;
            }

            if (clientRequest.messages.some(m=>typeof m?.content==='string'&&m.content.includes('[Chatbot attachment:'))) clientRequest.messages=await require('./core/attachments').expand(user.id,clientRequest.messages,selectedConnection?providers.usable(selectedConnection).vision:false);
            let extensionConfig;
            if(clientRequest.skillIds?.length || clientRequest.useTools){
                const extensions=require('./core/extensions');extensionConfig=await extensions.read();
                if(clientRequest.skillIds?.length)clientRequest.messages=[...extensions.activateSkills(extensionConfig.skills,clientRequest.skillIds,user.id),...clientRequest.messages];
                if(clientRequest.useTools&&(!selectedConnection||!providers.usable(selectedConnection).tools))throw Error('Selected connection does not support tool calling');
            }
            const controller = new AbortController();

            const onDisconnect = () => {
                if (!res.writableFinished) {
                    controller.abort();
                }
            };

            res.on("close", onDisconnect);

            try {
                if(clientRequest.useTools){
                    const extensions=require('./core/extensions');
                    res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","X-Chat-Connection":selectedConnection.id,"X-Chat-Model":encodeURIComponent(selectedConnection.model),"X-Chat-Provider":encodeURIComponent(selectedConnection.name),"X-Chat-Context":String(selectedConnection.contextLimit??"unknown")});
                    const emit=data=>{if(!res.destroyed)res.write('data: '+JSON.stringify(data)+'\n\n');};
                    const operationId=require('node:crypto').randomUUID();
                    const final=await extensions.runToolLoop({complete:input=>providers.complete(selectedConnection,input,{signal:controller.signal}),messages:clientRequest.messages,policy:extensions.policy(extensionConfig),user:user.id,operationId,signal:controller.signal,onActivity:toolActivity=>emit({toolActivity}),onDiagnostic:diagnostic=>systemLogs.log('MCP_TOOL_EXECUTION_FAILED',{correlationId:diagnostic.correlationId,metadata:{toolName:diagnostic.toolName,stage:diagnostic.stage,errorCategory:diagnostic.errorCategory,durationMs:diagnostic.durationMs}})});
                    if(typeof final.content!=='string'||!final.content.trim())throw Error('No final tool answer');
                    emit({choices:[{delta:{content:final.content},finish_reason:'stop'}],telemetry:final.telemetry});if(!res.destroyed)res.end('data: [DONE]\n\n');return;
                }
                const upstream = await providers.chat(provider, clientRequest, {signal:controller.signal});

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
                    "X-Chat-Connection": selectedConnection?.id || provider.id,
                    "X-Chat-Model": encodeURIComponent(selectedConnection?.model || provider.model),
                    "X-Chat-Provider": encodeURIComponent(provider.name),
                    "X-Chat-Context": selectedConnection ? String(selectedConnection.contextLimit ?? "unknown") : "local",
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
            logSystemEvent(req, "AUTH_LOGIN_FAILED", {
                metadata: { reason: "invalid_credentials" }
            });
            res.writeHead(401, {
                "Content-Type": "application/json; charset=utf-8"
            });
            res.end(JSON.stringify({ error: "Invalid username or password" }));
            return;
        }

        const token = createSession(db, user.id);
        logSystemEvent(req, "AUTH_LOGIN_SUCCEEDED", { actorId: user.id });

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Set-Cookie": sessionCookie(token, req.socket.localAddress),
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
    const user = token ? getSessionUser(db, token) : null;

    if (!user) {
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    deleteSession(db, token);
    logSystemEvent(req, "AUTH_LOGOUT", { actorId: user.id });

    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": sessionCookie('', req.socket.localAddress),
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify({ message: "Logged out" }));
    return;
}

// Administrator-only password reset
if (req.method === "POST" && req.url === "/api/admin/reset-password") {
    const admin = getAuthenticatedUser(req);

    if (!admin) {
        logAdminAccessDenied(req, admin);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
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
        logAdminAccessDenied(req, admin);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
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
        logAdminAccessDenied(req, admin);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
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
        logAdminAccessDenied(req, user);
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (user.is_admin !== 1) {
        logAdminAccessDenied(req, user);
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

// Real-time GPU telemetry; return cached sample if available, else on-demand collection
if (req.method === "GET" && req.url === "/api/admin/ai/telemetry/realtime") {
    const token = getSessionToken(req);
    const admin = getAuthenticatedUser(req);
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (!admin || admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
        res.writeHead(admin ? 403 : 401, headers);
        res.end(JSON.stringify({ error: "Administrator access required" })); return;
    }
    
    const current = getSessionUser(db, token);
    if (!current || current.id !== admin.id || current.is_admin !== 1) {
        logSystemEvent(req, "AUTH_ADMIN_ACCESS_DENIED", {
            actorId: admin.id,
            metadata: { resource: "admin_api", reason: "session_revoked" }
        });
        res.writeHead(401, headers); res.end(JSON.stringify({ error: "Session no longer authorized" })); return;
    }
    
    try {
        // Try to use cached sample (from background collector)
        let sample = gpuTelemetryCache.getCachedSample();
        
        // If cache is stale, don't perform on-demand collection - just indicate cache miss
        // Real-time clients should retry; this prevents overlapping nvidia-smi calls
        const source = sample ? 'cached' : 'unavailable';
        
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, headers);
        res.end(JSON.stringify({ 
            source,
            sample: sample || null,
            timestamp: Date.now()
        }));
    } catch (error) {
        console.error('Failed to fetch real-time telemetry:', error);
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: "Failed to fetch real-time telemetry" }));
    }
    return;
}

// Read-only GPU telemetry history; authorize before serving stored observations.
if (req.method === "GET" && /^\/api\/admin\/ai\/telemetry\/history\/(5m|30m|1h)$/.test(req.url)) {
    const token = getSessionToken(req);
    const admin = getAuthenticatedUser(req);
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (!admin || admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
        res.writeHead(admin ? 403 : 401, headers);
        res.end(JSON.stringify({ error: "Administrator access required" })); return;
    }
    const current = getSessionUser(db, token);
    if (!current || current.id !== admin.id || current.is_admin !== 1) {
        logSystemEvent(req, "AUTH_ADMIN_ACCESS_DENIED", {
            actorId: admin.id,
            metadata: { resource: "admin_api", reason: "session_revoked" }
        });
        res.writeHead(401, headers); res.end(JSON.stringify({ error: "Session no longer authorized" })); return;
    }
    
    const match = /\/telemetry\/history\/(\w+)$/.exec(req.url);
    const range = match ? match[1] : '5m';
    const timeRangeMs = range === '1h' ? 60*60*1000 : range === '30m' ? 30*60*1000 : 5*60*1000;
    
    try {
        const history = gpuTelemetryStorage.getHistory(timeRangeMs);
        const stats = gpuTelemetryStorage.getStatistics(timeRangeMs);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ range, timeRangeMs, samples: history, statistics: stats }));
    } catch (error) {
        console.error('Failed to fetch GPU telemetry history:', error);
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: "Failed to fetch telemetry history" }));
    }
    return;
}

// Read-only telemetry; authorize before collecting or serving cached observations.
if (req.method === "GET" && ["/api/admin/ai/telemetry", "/api/admin/ai/telemetry/status"].includes(req.url)) {
    const token = getSessionToken(req);
    const admin = getAuthenticatedUser(req);
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    if (!admin || admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
        res.writeHead(admin ? 403 : 401, headers);
        res.end(JSON.stringify({ error: "Administrator access required" })); return;
    }
    const sample = await getAdminTelemetry();
    const current = getSessionUser(db, token);
    if (!current || current.id !== admin.id || current.is_admin !== 1) {
        logSystemEvent(req, "AUTH_ADMIN_ACCESS_DENIED", {
            actorId: admin.id,
            metadata: { resource: "admin_api", reason: "session_revoked" }
        });
        res.writeHead(401, headers); res.end(JSON.stringify({ error: "Session no longer authorized" })); return;
    }
    if (sample.backend.state !== lastBackendHealthState) {
        systemLogs.log("RUNTIME_BACKEND_HEALTH_CHANGED", {
            metadata: {
                previousState: lastBackendHealthState,
                currentState: sample.backend.state
            }
        });
        lastBackendHealthState = sample.backend.state;
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
        logAdminAccessDenied(req, admin);
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
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

        const pid = process.platform === 'win32'
            ? await require('./core/llama-runtime').getLlamaServerPid() : null;

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
        logAdminAccessDenied(req, admin);
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
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

// Admin-only aggregate accounting; no ordinary-user usage-record endpoint.
if(['/api/admin/ai/openai-usage','/api/admin/ai/deepseek-usage'].includes(req.url)){
 const family=req.url.includes('deepseek')?'deepseek':'openai';
 const admin=getAuthenticatedUser(req),token=getSessionToken(req);
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 if(!admin||admin.is_admin!==1){logAdminAccessDenied(req,admin);reply(admin?403:401,{error:'Administrator access required'});return;}
 const accounting=require('./core/openai-usage').forProvider(family);
 try{
  if(req.method==='GET'){reply(200,accounting.summary(db));return;}
  if(req.method==='POST'){
   if(!require('./core/restart-request').validRestartRequest({...req,headers:{...req.headers,'x-chatbot-action':req.headers['x-chatbot-action']==='configure-'+family?'restart-ai':null}})){reply(403,{error:'Same-origin request required'});return;}
   let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw Error();}
   const current=getSessionUser(db,token);if(!current||current.id!==admin.id||current.is_admin!==1){
    logSystemEvent(req,'AUTH_ADMIN_ACCESS_DENIED',{actorId:admin.id,metadata:{resource:'admin_api',reason:'session_revoked'}});
    reply(401,{error:'Session no longer authorized'});return;
   }
   const before=accounting.settings(db);
   const updated=accounting.configure(db,JSON.parse(body));
   const changed=before.enabled!==updated.enabled||before.max_output_tokens!==updated.max_output_tokens||
    before.max_concurrent!==updated.max_concurrent||before.per_hour!==updated.per_hour||before.per_day!==updated.per_day;
   if(changed)logSystemEvent(req,family==='deepseek'?'CONFIG_DEEPSEEK_SAFEGUARDS_CHANGED':'CONFIG_OPENAI_SAFEGUARDS_CHANGED',{
    actorId:admin.id,metadata:{enabled:updated.enabled===1,maxOutputTokens:updated.max_output_tokens,
     maxConcurrent:updated.max_concurrent,perHour:updated.per_hour,perDay:updated.per_day}
   });
   reply(200,accounting.summary(db));return;
  }
  reply(405,{error:'Method not allowed'});
 }catch{reply(400,{error:'Provider safeguards unavailable or invalid'});}return;
}
if(/^\/api\/admin\/ai\/connections\/[a-z0-9-]+\/(credential|test)$/.test(req.url)){
 const token=getSessionToken(req);
 await require('./core/deepseek-admin').handle({req,res,db,connections,authenticate:()=>getSessionUser(db,token),
  log:(code,fields)=>logSystemEvent(req,code,fields)});return;
}
// Named connection administration; credentials are references, never values.
if (req.url === "/api/admin/ai/connections/presets" || req.url === "/api/admin/ai/connections" || /^\/api\/admin\/ai\/connections\/[a-z0-9-]+\/check$/.test(req.url)) {
    const token = getSessionToken(req), admin = getAuthenticatedUser(req);
    const reply = (status, data) => {res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(data));};
    if (!admin || admin.is_admin !== 1) {logAdminAccessDenied(req,admin);reply(admin?403:401,{error:"Administrator access required"});return;}
    try {
        if(req.method==="GET"&&req.url==="/api/admin/ai/connections/presets"){reply(200,require("./core/provider-presets.json"));return;}
        if (req.method === "GET" && req.url === "/api/admin/ai/connections") {
            const config=await connections.read();const current=getSessionUser(db,token);if(!current||current.id!==admin.id||current.is_admin!==1){
             logSystemEvent(req,'AUTH_ADMIN_ACCESS_DENIED',{actorId:admin.id,metadata:{resource:'admin_api',reason:'session_revoked'}});
             reply(401,{error:"Session no longer authorized"});return;
            }reply(200,config);return;
        }
        if (req.method === "POST") {
            if (!require("./core/restart-request").validRestartRequest({...req,headers:{...req.headers,"x-chatbot-action":req.headers["x-chatbot-action"]==="configure-connections"?"restart-ai":null}})) {reply(403,{error:"Same-origin request required"});return;}
            let text="";for await(const chunk of req){text+=chunk;if(text.length>32768)throw Error("Invalid request");}
            const current=getSessionUser(db,token);if(!current||current.id!==admin.id||current.is_admin!==1){
             logSystemEvent(req,'AUTH_ADMIN_ACCESS_DENIED',{actorId:admin.id,metadata:{resource:'admin_api',reason:'session_revoked'}});
             reply(401,{error:"Session no longer authorized"});return;
            }
            if(req.url === "/api/admin/ai/connections"){const input=JSON.parse(text),checked=require('./core/connections').validate(input);
            for(const c of checked.connections){if(c.adapter==='deepseek-chat'&&c.credentialRef==='protected:'+c.id&&c.enabled!==false&&!await require('./core/protected-credentials').configured(c)){reply(400,{error:'Save this provider disabled, then save its API key before enabling.'});return;}}
            const verified=getSessionUser(db,token);if(!verified||verified.id!==admin.id||verified.is_admin!==1){
             logSystemEvent(req,'AUTH_ADMIN_ACCESS_DENIED',{actorId:admin.id,metadata:{resource:'admin_api',reason:'session_revoked'}});
             reply(401,{error:'Session no longer authorized'});return;
            }
            const saved=await connections.save(input);
            logSystemEvent(req,'PROVIDER_CONFIGURATION_CHANGED',{actorId:admin.id,metadata:{
             providerCount:saved.connections.length,enabledCount:saved.connections.filter(connection=>connection.enabled!==false).length,change:'saved'
            }});
            reply(200,saved);return;}
            const id=req.url.split('/')[5],config=await connections.read(),c=config.connections.find(c=>c.id===id);
            if(!c){reply(404,{error:"Connection not found"});return;}
            const startedAt=Date.now();
            logSystemEvent(req,'PROVIDER_CONNECTION_TEST_STARTED',{actorId:admin.id,providerId:c.id,metadata:{diagnostic:false}});
            let result;
            try {
                result=await providers.testConnection(c,{signal:AbortSignal.timeout(8000)});
            } catch(error) {
                logSystemEvent(req,'PROVIDER_CONNECTION_TEST_FAILED',{actorId:admin.id,providerId:c.id,metadata:{
                 reason:'operation_failed',durationMs:Math.min(10000000,Math.max(0,Date.now()-startedAt))
                }});
                throw error;
            }
            logSystemEvent(req,'PROVIDER_CONNECTION_TEST_COMPLETED',{actorId:admin.id,providerId:c.id,metadata:{
             durationMs:Math.min(10000000,Math.max(0,Date.now()-startedAt)),modelCount:Array.isArray(result.models)?result.models.length:0
            }});
            const verified=getSessionUser(db,token);if(!verified||verified.id!==admin.id||verified.is_admin!==1){
             logSystemEvent(req,'AUTH_ADMIN_ACCESS_DENIED',{actorId:admin.id,metadata:{resource:'admin_api',reason:'session_revoked'}});
             reply(401,{error:"Session no longer authorized"});return;
            }reply(200,{models:result.models,usable:result.capabilities});return;
        }
        reply(405,{error:"Method not allowed"});
    } catch(error) {
        if(error?.message==='CONNECTION_CONFLICT'){reply(409,{error:'Configuration changed; reload.'});}
        else {reply(400,{error:error instanceof SyntaxError?'Invalid connection configuration JSON.':error?.message||'Connection operation unavailable or invalid.'});}
    }
    return;
}

// Administrator-only AI configuration
if (req.method === "GET" && req.url === "/api/admin/ai/config") {
    const user = getAuthenticatedUser(req);

    if (!user) {
        logAdminAccessDenied(req, user);
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (user.is_admin !== 1) {
        logAdminAccessDenied(req, user);
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
        logAdminAccessDenied(req, admin);
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (admin.is_admin !== 1) {
        logAdminAccessDenied(req, admin);
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
        for (const key of ["gpuLayers", "device", "verbosity", "metrics"]) {
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
        const changedFields = ["model", "parallel", "contextSize", "gpuLayers", "device", "verbosity", "metrics"]
            .filter(key => Object.hasOwn(config, key) && config[key] !== previous[key]);
        if (changedFields.length) {
            logSystemEvent(req, "CONFIG_ADMIN_SETTINGS_UPDATED", {
                actorId: admin.id,
                metadata: { changedFields }
            });
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
        logAdminAccessDenied(req, user);
        res.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ error: "Authentication required" }));
        return;
    }

    if (user.is_admin !== 1) {
        logAdminAccessDenied(req, user);
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
        logAdminAccessDenied(req, user);
        res.writeHead(401);
        res.end("Authentication required");
        return;
    }

    if (user.is_admin !== 1) {
        logAdminAccessDenied(req, user);
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
    systemLogs.startRetention();
    require('./core/openai-usage').reconcile(db);
    require('./core/openai-usage').forProvider('deepseek').reconcile(db);
    backgroundTelemetryCollector.start();
    require("./core/application-lifecycle").installApplicationLifecycle({
        server, requestTracker, db,
        beforeDatabaseClose: async () => {
            backgroundTelemetryCollector.stop();
            await benchmarkRunner.stop();
            await systemLogs.flush();
            systemLogs.stop();
        }
    });
    console.log("");
    console.log("Local AI Chatbot");
    console.log("----------------");
    console.log(`UI:    http://${HOST}:${PORT}`);
    console.log(`Llama: ${LLAMA_URL}`);
    console.log("");
});

// Desktop bootstrap retains this exact server; normal command-line startup is unchanged.
module.exports = { server };
