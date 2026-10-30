const chat = document.getElementById("chat");
const promptBox = document.getElementById("prompt");
const sendButton = document.getElementById("send");
const stopButton = document.getElementById("stop");
stopButton.disabled = true;
const newChatButton = document.getElementById("newChat");
const deleteChatButton = document.getElementById("deleteChat");
const settingsToggle = document.getElementById("settingsToggle");
const settingsPanel = document.getElementById("settingsPanel");
const thinkingToggle = document.getElementById("thinking");
const systemPromptBox = document.getElementById("systemPrompt");
const themeSelect = document.getElementById("theme");
const temperatureInput = document.getElementById("temperature");
const maxTokensInput = document.getElementById("maxTokens");
const statusText = document.getElementById("status");
const chatList = document.getElementById("chatList");
const activeChatTitle = document.getElementById("activeChatTitle");
const chatContextMenu = document.getElementById("chatContextMenu");
const renameChatAction = document.getElementById("renameChatAction");

const chatActionsToggle = document.getElementById("chatActionsToggle");
const attachmentInput = document.getElementById("attachment");
const attachmentName = document.getElementById("attachmentName");
const removeAttachmentButton = document.getElementById("removeAttachment");

attachmentInput.addEventListener("change", () => {
    const file = attachmentInput.files[0];

    if (file && (
        !file.name.toLowerCase().endsWith(".txt") ||
        file.size > 100 * 1024
    )) {
        if (typeof terminalAlert === "function") {
            terminalAlert("Please select a .txt file no larger than 100 KB.", "ATTACHMENT ERROR");
        } else {
            alert("Please select a .txt file no larger than 100 KB.");
        }
        attachmentInput.value = "";
        attachmentName.textContent = "";
        attachmentName.hidden = true;
        removeAttachmentButton.hidden = true;
        return;
    }

    attachmentName.textContent = file ? file.name : "";
    attachmentName.hidden = !file;
    removeAttachmentButton.hidden = !file;
});

removeAttachmentButton.addEventListener("click", () => {
    attachmentInput.value = "";
    attachmentName.textContent = "";
    attachmentName.hidden = true;
    removeAttachmentButton.hidden = true;
});

async function readSelectedAttachment() {
    const file = attachmentInput.files[0];
    if (!file) return null;

    return {
        name: file.name,
        content: await file.text()
    };
}

chatActionsToggle.addEventListener("click", (event) => {
    event.stopPropagation();

    if (!loginScreen.hidden || !chatStore.activeChatId) {
        return;
    }

    contextMenuChatId = chatStore.activeChatId;

    const rect = chatActionsToggle.getBoundingClientRect();
    chatContextMenu.hidden = false;
    const menuWidth = chatContextMenu.getBoundingClientRect().width;


const left = Math.max(
    8,
    Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)
);

chatContextMenu.style.left = `${left}px`;
chatContextMenu.style.top = `${rect.bottom}px`;
    
});

let contextMenuChatId = null;


async function loadAiRuntime() {
    const epoch = sessionEpoch;
    try {
        const response = await fetch("/api/ai/runtime", {
            cache: "no-store",
            credentials: "same-origin"
        });
        if (epoch !== sessionEpoch) return;

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const runtime = await response.json();
        if (epoch !== sessionEpoch) return;

        if (
            Number.isInteger(runtime.contextLimit) &&
            runtime.contextLimit > 0
        ) {
            contextLimit = runtime.contextLimit;
        }
        if (typeof runtime.modelName === "string" && runtime.modelName.trim()) {
            activeModelName = runtime.modelName.trim();
        }

    } catch (error) {
        if (epoch !== sessionEpoch) return;
        console.error(
            "Failed to load AI runtime information:",
            error
        );
    }
}

async function loadUserSettings() {
    const epoch = sessionEpoch;
    try {
        const response = await fetch("/api/settings", {
            cache: "no-store",
            credentials: "same-origin"
        });
        if (epoch !== sessionEpoch) return;

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const settings = await response.json();
        if (epoch !== sessionEpoch) return;

        systemPromptBox.value = settings.systemPrompt;
        themeSelect.value = settings.theme;
        applyTheme(settings.theme);
        temperatureInput.value = settings.temperature;
        maxTokensInput.value = settings.maxTokens;
        thinkingToggle.checked = settings.thinking;

    } catch (error) {
        if (epoch !== sessionEpoch) return;
        console.error("Failed to load user settings:", error);

        systemPromptBox.value = "";
        themeSelect.value = "dark";
        applyTheme("dark");
        temperatureInput.value = "0.7";
        maxTokensInput.value = "4096";
        thinkingToggle.checked = false;
    }
}    

function applyTheme(theme) {
    document.body.dataset.theme = theme === "light" ? "light" : "dark";
}

let chatStore = {
    activeChatId: null,
    chats: {}
};

let messages = [];

chat.innerHTML = "";
chatList.innerHTML = "";

let generating = false;
let sessionEpoch = 0;
let nextGenerationId = 0;
let activeGeneration = null;
let historyLoadSequence = 0;
function requireServerRevision(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid server chat revision");
    return value;
}
async function readHistorySnapshot(response) {
    const header = response.headers.get("X-Chat-Revision");
    if (header === null || !/^(0|[1-9][0-9]*)$/.test(header)) throw new Error("Missing or invalid chat revision");
    const serverRevision = requireServerRevision(Number(header));
    const history = await response.json();
    if (!Array.isArray(history)) throw new Error("Invalid chat history");
    return { serverRevision, messages: history };
}
async function reconcileConversation(chatId) {
    const target = chatStore.chats[chatId];
    if (!target) return;
    const epoch = sessionEpoch;
    const requestId = (target.reconciliationId || 0) + 1;
    target.reconciliationId = requestId;
    target.lifecyclePending = true;
    target.historyRevision = (target.historyRevision || 0) + 1;
    const revision = target.historyRevision;
    invalidateGeneration(chatId);
    delete target.transientResponse;
    // Discard rejected/uncertain local output even if reconciliation fails.
    target.messages = [];
    const current = () => epoch === sessionEpoch && chatStore.chats[chatId] === target &&
        target.reconciliationId === requestId && target.historyRevision === revision;
    if (chatStore.activeChatId === chatId) { messages = target.messages; restoreChat(); }
    try {
        const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`,
            { credentials: "same-origin", cache: "no-store" });
        if (!current()) return;
        if (response.status === 404) {
            delete chatStore.chats[chatId];
            if (chatStore.activeChatId === chatId) {
                chatStore.activeChatId = Object.keys(chatStore.chats)[0] ?? null;
                messages = chatStore.activeChatId ? chatStore.chats[chatStore.activeChatId].messages : [];
                if (chatStore.activeChatId) restoreChat(); else chat.innerHTML = "";
            }
            renderChatList();
            return;
        }
        if (!response.ok) throw new Error(`History reload failed: HTTP ${response.status}`);
        const snapshot = await readHistorySnapshot(response);
        if (!current()) return;
        target.messages = snapshot.messages;
        target.serverRevision = snapshot.serverRevision;
        target.lifecyclePending = false;
        if (chatStore.activeChatId === chatId) { messages = target.messages; restoreChat(); }
        renderChatList();
    } catch (error) {
        if (!current()) return;
        console.error("Conversation reconciliation failed:", error);
        if (chatStore.activeChatId === chatId) statusText.textContent = "History could not be verified. Reload before sending.";
    }
}
const assistantViews = new WeakMap();
function generationIsValid(g) {
    return activeGeneration === g && !g.invalid && g.epoch === sessionEpoch &&
        chatStore.chats[g.chatId] === g.chat &&
        (g.chat.historyRevision || 0) === g.revision && g.chat.messages === g.messages;
}
function invalidateGeneration(chatId = null) {
    const g = activeGeneration;
    if (!g || (chatId !== null && g.chatId !== chatId)) return;
    g.invalid = true;
    g.controller.abort();
    g.view?.container.remove();
    if (activeGeneration === g) {
        activeGeneration = null;
        generating = false;
        controller = null;
        sendButton.disabled = false;
        stopButton.disabled = true;
    }
}
function replaceSession() {
    sessionEpoch++;
    invalidateGeneration();
    return sessionEpoch;
}
let controller = null;
let contextLimit = 8192;
let activeModelName = "Assistant";

async function checkHealth() {
    try {
        const response = await fetch("/health");
        const data = await response.json();

        if (data.status === "ok") {
            statusText.textContent = "Connected";
        } else {
            statusText.textContent = "Backend unavailable";
        }
    } catch {
        statusText.textContent = "Disconnected";
    }
}

function addMessage(role, content = "", mount = true) {
    const container = document.createElement("div");
    container.className = `message ${role}`;

    const roleLabel = document.createElement("div");
    roleLabel.className = "role";
    roleLabel.textContent =
        role === "user" ? "You" : activeModelName;

    const text = document.createElement("div");
    text.textContent = content;

    const telemetry = document.createElement("div");
    telemetry.className = "telemetry";  

    container.appendChild(roleLabel);
    let thinking = null;
    let reasoning = null;
    const notice = document.createElement("div");
    notice.className = "completion-notice";
    notice.hidden = true;
    notice.setAttribute("role", "status");
    if (role === "assistant") {
        thinking = document.createElement("details");
        thinking.className = "message-thinking";
        thinking.hidden = true;
        const summary = document.createElement("summary");
        summary.textContent = "Thinking";
        reasoning = document.createElement("div");
        reasoning.className = "message-reasoning";
        thinking.appendChild(summary);
        thinking.appendChild(reasoning);
        container.appendChild(thinking);
    }
    container.appendChild(text);

    if (role === "assistant") {
        container.appendChild(notice);
        container.appendChild(telemetry);
    }

    if (mount) {
        chat.appendChild(container);
        chat.scrollTop = chat.scrollHeight;
    }

    return {container, text, telemetry, thinking, reasoning, notice};
}

function restoreChat() {
    chat.innerHTML = "";

    messages.forEach((message) => {
        const retained = assistantViews.get(message);
        if (retained) {
            retained.thinking.hidden = !thinkingToggle.checked || !retained.reasoning.textContent;
            if (!thinkingToggle.checked) retained.thinking.open = false;
            chat.appendChild(retained.container);
            return;
        }
        const restoredMessage =
    addMessage(
        message.role,
        message.displayContent ?? message.content
    );

        if (message.role === "assistant") {
            restoredMessage.text.innerHTML =
                DOMPurify.sanitize(
                    marked.parse(message.content)
                );
            if (message.telemetry) {
                const t = message.telemetry;

                restoredMessage.telemetry.textContent =
                    `Generated: ${t.generatedTokens} • ` +
                    `${t.generationSpeed.toFixed(1)} t/s • ` +
                    `${t.generationSeconds.toFixed(2)} s | ` +
                    `Context: ${t.contextTokens}/${t.contextLimit} • ` +
                    `Cached: ${t.cachedTokens} • ` +
                    `Prompt: ${t.promptTokens}`;
            }
        }
    });

    if (activeGeneration && activeGeneration.chat === chatStore.chats[chatStore.activeChatId] && activeGeneration.view && !activeGeneration.saved) {
        const view = activeGeneration.view;
        view.thinking.hidden = !thinkingToggle.checked || !view.reasoning.textContent;
        if (!thinkingToggle.checked) view.thinking.open = false;
        chat.appendChild(view.container);
    }

    const transient = chatStore.chats[chatStore.activeChatId].transientResponse;
    if (transient) {
        transient.thinking.hidden = !thinkingToggle.checked || !transient.reasoning.textContent;
        if (!thinkingToggle.checked) transient.thinking.open = false;
        chat.appendChild(transient.container);
    }

    const savedScrollTop =
        chatStore.chats[
            chatStore.activeChatId
        ].scrollTop;

    if (savedScrollTop !== undefined) {
        chat.scrollTop = savedScrollTop;
    }
}

function updateDeleteChatButtonState() {
    deleteChatButton.disabled = Object.keys(chatStore.chats).length === 0;
    deleteChatButton.textContent = "Clear chat";
}

function updateActiveChatTitle() {
    const activeChat = chatStore.chats[chatStore.activeChatId];

    activeChatTitle.textContent = activeChat?.title || "";
    activeChatTitle.title = activeChat?.title || "";
}

function closeChatContextMenu() {
    chatContextMenu.hidden = true;
    contextMenuChatId = null;
}

async function renameChat(chatId) {
    const chatData = chatStore.chats[chatId];

    if (!chatData) return;

    const requestedTitle = typeof terminalPrompt === "function"
        ? await terminalPrompt("RENAME MEMORY FILE", chatData.title)
        : prompt("Enter a chat name (maximum 100 characters):", chatData.title);

    if (requestedTitle === null) return;

    const trimmedTitle = requestedTitle.trim();

    if (!trimmedTitle) {
        if (typeof terminalAlert === "function") {
            await terminalAlert("Chat name cannot be empty.", "INVALID INPUT");
        } else {
            alert("Chat name cannot be empty.");
        }
        return;
    }

    if (trimmedTitle.length > 100) {
        if (typeof terminalAlert === "function") {
            await terminalAlert("Chat name must be 100 characters or fewer.", "INVALID INPUT");
        } else {
            alert("Chat name must be 100 characters or fewer.");
        }
        return;
    }

    chatData.title = trimmedTitle;

    try {
    const response = await fetch(
        `/api/chats/${encodeURIComponent(chatId)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ title: trimmedTitle })
        }
    );

    if (!response.ok) {
        throw new Error(`Rename failed: HTTP ${response.status}`);
    }
} catch (error) {
    console.error("Could not rename chat:", error);
    if (typeof terminalAlert === "function") {
        await terminalAlert("Could not rename the chat. Please try again.", "LINK ERROR");
    } else {
        alert("Could not rename the chat. Please try again.");
    }
    return;
}

    updateActiveChatTitle();
    renderChatList();
}

function renderChatList() {
        chatList.innerHTML = "";

        updateDeleteChatButtonState();
        updateActiveChatTitle();

        Object.entries(chatStore.chats)
            .forEach(([chatId, chatData]) => {
                const button =
                    document.createElement("button");

                button.textContent =
                    chatData.title;

                button.title = chatData.title;

                button.dataset.chatId =
                    chatId;

                if (chatId === chatStore.activeChatId) {
                    button.classList.add("active");
                }

                button.addEventListener("click", () => {
                    
                    const currentChat =
                        chatStore.chats[
                        chatStore.activeChatId
                    ];

                    currentChat.scrollTop =
                    chat.scrollTop;
                    
                    chatStore.activeChatId = chatId;

                        messages =
                            chatStore.chats[chatId].messages;

                        renderChatList();

                        restoreChat();

                    });

                chatList.appendChild(button);
            });
}

renameChatAction.addEventListener("click", () => {
    const chatId = contextMenuChatId;
    closeChatContextMenu();
    renameChat(chatId);
});

const clearChatAction = document.getElementById("clearChatAction");

clearChatAction.addEventListener("click", () => {
    const chatId = contextMenuChatId;
    closeChatContextMenu();
    clearConversation(chatId);
});

const deleteChatAction = document.getElementById("deleteChatAction");

deleteChatAction.addEventListener("click", async () => {
    const epoch = sessionEpoch;
    const chatId = contextMenuChatId ?? chatStore.activeChatId;
    const activeChat = chatStore.chats[chatId];

    closeChatContextMenu();

    if (!loginScreen.hidden || !activeChat || activeChat.lifecyclePending) return;

    const confirmedDelete = typeof terminalConfirm === "function"
        ? await terminalConfirm(`Delete "${activeChat.title}" and all its messages?`, "DELETE MEMORY FILE")
        : confirm(`Delete "${activeChat.title}" and all its messages?`);

    if (!confirmedDelete) {
        return;
    }

    activeChat.lifecyclePending = true;
    activeChat.historyRevision = (activeChat.historyRevision || 0) + 1;
    invalidateGeneration(chatId);
    delete activeChat.transientResponse;
    try {
        const response = await fetch(
            `/api/chats/${encodeURIComponent(chatId)}`,
            { method: "DELETE", credentials: "same-origin" }
        );

        if (!response.ok) {
            throw new Error(`Delete chat failed: HTTP ${response.status}`);
        }

        if (epoch !== sessionEpoch || chatStore.chats[chatId] !== activeChat) return;
        delete chatStore.chats[chatId];

        if (chatStore.activeChatId === chatId) chatStore.activeChatId =
            Object.keys(chatStore.chats)[0] ?? null;

        messages = chatStore.activeChatId
            ? chatStore.chats[chatStore.activeChatId].messages
            : [];

        renderChatList();

        if (chatStore.activeChatId) {
            restoreChat();
        } else {
            chat.innerHTML = "";
        }
    } catch (error) {
        if (epoch !== sessionEpoch) return;
        console.error("Could not delete chat:", error);
        activeChat.lifecyclePending = false;
        if (typeof terminalAlert === "function") {
            await terminalAlert("Could not delete the chat. Please try again.", "LINK ERROR");
        } else {
            alert("Could not delete the chat. Please try again.");
        }
    }
});

document.addEventListener("click", (event) => {
    if (!chatContextMenu.hidden && !chatContextMenu.contains(event.target)) {
        closeChatContextMenu();
    }
});

window.addEventListener("resize", closeChatContextMenu);


async function readAssistantStream(reader, onChunk) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let dataLines = [];
    let completed = false;
    function dispatch() {
        if (!dataLines.length || completed) return;
        const data = dataLines.join("\n");
        dataLines = [];
        if (data.trim() === "[DONE]") {
            completed = true;
            return;
        }
        onChunk(JSON.parse(data));
    }
    function line(value) {
        if (value.endsWith("\r")) value = value.slice(0, -1);
        if (value === "") dispatch();
        else if (value === "data" || value.startsWith("data:")) {
            dataLines.push(value === "data" ? "" : value.slice(5).replace(/^ /, ""));
        }
    }
    try {
        while (!completed) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let end;
            while (!completed && (end = buffer.indexOf("\n")) !== -1) {
                const next = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                line(next);
            }
            if (done) {
                if (!completed && buffer) line(buffer);
                if (!completed) dispatch();
                break;
            }
        }
        if (!completed) throw new Error("Stream ended before completion.");
    } finally {
        if (completed) {
            try { await reader.cancel(); } catch (_) { /* Completion already received. */ }
        }
        reader.releaseLock();
    }
}

async function sendMessage() {
    if (!loginScreen.hidden || !chatStore.activeChatId) {
    return;
}
    const prompt = promptBox.value.trim();

    if (!prompt || generating) return;

    const responseChatId = chatStore.activeChatId;
    const originChat = chatStore.chats[responseChatId];
    if (!originChat || originChat.lifecyclePending) return;
    if (!Number.isSafeInteger(originChat.serverRevision) || originChat.serverRevision < 0) {
        await reconcileConversation(responseChatId);
        return;
    }
    const originMessages = originChat.messages;
    const requestHistory = originMessages.map(({ role, content }) => ({ role, content }));
    const thinkingEnabled = thinkingToggle.checked;
    const generationSettings = {
        systemPrompt: systemPromptBox.value.trim(),
        temperature: Number(temperatureInput.value),
        maxTokens: Number(maxTokensInput.value)
    };
    const isOriginVisible = () => chatStore.activeChatId === responseChatId && chatStore.chats[responseChatId] === originChat;
    const generation = {
        id: ++nextGenerationId, chatId: responseChatId, chat: originChat,
        messages: originMessages, revision: originChat.historyRevision || 0,
        epoch: sessionEpoch, controller: new AbortController(),
        invalid: false, view: null, saved: false
    };
    Object.defineProperty(generation, "expectedRevision", { value: originChat.serverRevision, enumerable: true });
    activeGeneration = generation;
    generating = true;
    sendButton.disabled = true;
    controller = generation.controller;
    stopButton.disabled = false;
    let attachment;
    try {
        attachment = await readSelectedAttachment();
        if (!generationIsValid(generation)) return;
    } catch (error) {
        if (!generationIsValid(generation)) return;
        activeGeneration = null;
        generating = false;
        sendButton.disabled = false;
        stopButton.disabled = true;
        controller = null;
        if (isOriginVisible()) statusText.textContent = "Could not read attachment.";
        return;
    }

    if (attachment) {
        console.log("Attachment ready:", {
            name: attachment.name,
            characters: attachment.content.length
    });
}

const messageContent = attachment
    ? `${prompt}\n\nAttached file: ${attachment.name}\n\n${attachment.content}`
    : prompt;

    stopButton.disabled = false;
    controller = generation.controller;
    if (isOriginVisible()) {
        document.querySelectorAll(".telemetry.active").forEach((element) => {
            element.classList.remove("active");
        });
        promptBox.value = "";
        attachmentInput.value = "";
        attachmentName.textContent = "";
        attachmentName.hidden = true;
        removeAttachmentButton.hidden = true;
    }

    const userMessage = {
        role: "user",
        content: messageContent,
        displayContent: attachment ? prompt + "\n\nAttached file: " + attachment.name : null
    };
    delete originChat.transientResponse;
    originMessages.push(userMessage);
    requestHistory.push({ role: "user", content: messageContent });
    if (isOriginVisible()) restoreChat();

try {
    const response = await fetch(
        `/api/chats/${encodeURIComponent(responseChatId)}/messages`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
    role: "user",
    content: messageContent,
    expectedRevision: generation.expectedRevision,
    displayContent: attachment
        ? `${prompt}\n\nAttached file: ${attachment.name}`
        : null
})
        }
    );

    if (!generationIsValid(generation)) return;
    if (response.status === 409) {
        await reconcileConversation(responseChatId);
        return;
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
} catch (error) {
    console.error("Could not save user message to SQLite:", error);
}

    if (!generationIsValid(generation)) return;
    renderChatList();

    await loadAiRuntime();
    if (!generationIsValid(generation)) return;

    const assistantMessage =
        addMessage("assistant", "", isOriginVisible());
    generation.view = assistantMessage;

    const assistantElement =
        assistantMessage.text;

    const telemetryElement = 
        assistantMessage.telemetry;
    let responseTelemetry = null;

    let assistantText = "";
    let reasoningText = "";
    let finishReason = null;

    try {
        if (isOriginVisible()) statusText.textContent = "Generating...";

        const response = await fetch("/api/chat", {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: generationSettings.systemPrompt
                    },
                    ...requestHistory
                ],
                enable_thinking: thinkingEnabled,
                temperature: generationSettings.temperature,
                max_tokens: generationSettings.maxTokens
            }),
            signal: generation.controller.signal,
        });

        if (!generationIsValid(generation)) return;
        if (!response.ok) {
            throw new Error(
                await response.text()
            );
        }

        if (!generationIsValid(generation)) return;
        await readAssistantStream(response.body.getReader(), (chunk) => {
            if (!generationIsValid(generation)) throw new DOMException("Obsolete generation", "AbortError");
            if (chunk.choices?.[0]?.finish_reason != null) {
                finishReason = chunk.choices[0].finish_reason;
            }
                        if (chunk.timings && ["predicted_n", "predicted_per_second", "predicted_ms", "cache_n", "prompt_n"].every(
                            key => Number.isFinite(chunk.timings[key]))) {
                            const timings = chunk.timings;

                            const generatedTokens =
                                timings.predicted_n;

                            const generationSpeed =
                                timings.predicted_per_second;

                            const generationSeconds =
                                timings.predicted_ms / 1000;

                            const contextTokens =
                                timings.cache_n +
                                timings.prompt_n +
                                timings.predicted_n;

                            const contextPercent =
                                (contextTokens / contextLimit) * 100;
                                
                            const cachedTokens =
                                timings.cache_n;

                            const promptTokens =
                                timings.prompt_n;

                                responseTelemetry = {
                                generatedTokens,
                                generationSpeed,
                                generationSeconds,
                                contextTokens,
                                contextLimit,
                                cachedTokens,
                                promptTokens,
                                timestamp: new Date().toISOString()
                                };

                            telemetryElement.textContent =
                                `Generated: ${generatedTokens} • ` +
                                `${generationSpeed.toFixed(1)} t/s • ` +
                                `${generationSeconds.toFixed(2)} s | ` +
                                `Context: ${contextTokens}/${contextLimit} ` +
                                `(${contextPercent.toFixed(1)}%) • ` +
                                `Cached: ${cachedTokens} • ` +
                                `Prompt: ${promptTokens}`;

                            telemetryElement.classList.add("active");

                        }

                    const delta =
                        chunk.choices?.[0]?.delta;

                    if (thinkingEnabled && typeof delta?.reasoning_content === "string") {
                        reasoningText += delta.reasoning_content;
                        assistantMessage.reasoning.textContent = reasoningText;
                        assistantMessage.thinking.hidden =
                            !thinkingToggle.checked || !reasoningText;
                    }

                    if (delta?.content) {
                        assistantText +=
                            delta.content;

                        assistantElement.innerHTML =
                            DOMPurify.sanitize(
                                marked.parse(assistantText)
                            );

                        if (isOriginVisible()) chat.scrollTop = chat.scrollHeight;
                    }

        });
        if (!generationIsValid(generation)) return;
        if (finishReason === "length") {
            assistantMessage.notice.textContent = assistantText.trim()
                ? "Token limit reached. The answer may be incomplete."
                : "Token limit reached before a final answer was produced.";
        } else if (finishReason && finishReason !== "stop") {
            assistantMessage.notice.textContent = "Response ended without normal completion.";
        } else if (!assistantText.trim()) {
            assistantMessage.notice.textContent = "No final answer was returned.";
        }
        if (isOriginVisible()) statusText.textContent = "Connected";
    } catch (error) {
        if (!generationIsValid(generation)) return;
        const cancelled = error.name === "AbortError";
        assistantMessage.notice.textContent = cancelled
            ? "Generation stopped. The response may be incomplete."
            : "Response interrupted: " + error.message;
        if (isOriginVisible()) statusText.textContent = cancelled ? "Stopped" : "Error";
    } finally {
        if (!generationIsValid(generation)) return;
        assistantMessage.notice.hidden = !assistantMessage.notice.textContent;
        try {
            if (assistantText.trim()) {
                const savedMessage = { role: "assistant", content: assistantText, telemetry: responseTelemetry };
                originMessages.push(savedMessage);
                assistantViews.set(savedMessage, assistantMessage);
                generation.saved = true;
                const saved = await fetch(
                    "/api/chats/" + encodeURIComponent(responseChatId) + "/messages",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ ...savedMessage, expectedRevision: generation.expectedRevision })
                    }
                );
                if (!generationIsValid(generation)) return;
                if (saved.status === 409) {
                    await reconcileConversation(responseChatId);
                    return;
                }
                if (!saved.ok) throw new Error("HTTP " + saved.status);
            }
        } catch (saveError) {
            if (!generationIsValid(generation)) return;
            console.error("Could not save assistant message to SQLite:", saveError);
        }
        if (!generationIsValid(generation)) return;
        if (!generation.saved && (reasoningText || assistantMessage.notice.textContent)) {
            originChat.transientResponse = assistantMessage;
        }
        activeGeneration = null;
        generating = false;
        sendButton.disabled = false;
        stopButton.disabled = true;
        promptBox.focus();
    }
}

sendButton.addEventListener(
    "click",
    sendMessage
);

promptBox.addEventListener(
    "keydown",
    event => {
        if (
            event.key === "Enter" &&
            !event.shiftKey
        ) {
            event.preventDefault();
            sendMessage();
        }
    }
);

async function saveUserSettings() {
    const settings = {
        systemPrompt: systemPromptBox.value,
        theme: themeSelect.value,
        temperature: Number(temperatureInput.value),
        maxTokens: Number(maxTokensInput.value),
        thinking: thinkingToggle.checked
    };

    try {
        const response = await fetch("/api/settings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "same-origin",
            body: JSON.stringify(settings)
        });

        if (!response.ok) {
            const result = await response.json();
            throw new Error(
                result.error || `HTTP ${response.status}`
            );
        }

    } catch (error) {
        console.error("Failed to save user settings:", error);
    }
}

systemPromptBox.addEventListener("change", saveUserSettings);
themeSelect.addEventListener("change", () => {
    applyTheme(themeSelect.value);
    saveUserSettings();
});
temperatureInput.addEventListener("change", saveUserSettings);
maxTokensInput.addEventListener("change", saveUserSettings);
thinkingToggle.addEventListener("change", () => {
    chat.querySelectorAll(".message-thinking").forEach((thinking) => {
        const reasoning = thinking.querySelector(".message-reasoning");
        thinking.hidden = !thinkingToggle.checked || !reasoning.textContent;
        if (!thinkingToggle.checked) thinking.open = false;
    });
    saveUserSettings();
});

settingsToggle.addEventListener("click", () => {
    const isHidden = settingsPanel.hidden;
    settingsPanel.hidden = !isHidden;
    settingsToggle.setAttribute("aria-expanded", String(!isHidden));
    settingsToggle.textContent = isHidden ? "Close settings" : "Settings";
});

newChatButton.addEventListener(
    "click",
    async () => {
    const epoch = sessionEpoch;
        if (!loginScreen.hidden) {
    return;
}
        let newChatId;
        let newChatTitle;
        let serverRevision;

try {
    const response = await fetch("/api/chats", {
        method: "POST"
    });
        if (epoch !== sessionEpoch) return;

    if (!response.ok) {
        throw new Error(`Chat creation failed: HTTP ${response.status}`);
    }

    const createdChat = await response.json();
        if (epoch !== sessionEpoch) return;
    newChatId = createdChat.id;
    newChatTitle = createdChat.title;
    serverRevision = requireServerRevision(createdChat.revision);
} catch (error) {
        if (epoch !== sessionEpoch) return;
    console.error("Could not create chat:", error);
    if (typeof terminalAlert === "function") {
        await terminalAlert("Could not create a new chat. Please try again.", "LINK ERROR");
    } else {
        alert("Could not create a new chat. Please try again.");
    }
    return;
}

        chatStore.chats[newChatId] = {
            title: newChatTitle,
            serverRevision,
            messages: []
        };

        chatStore.activeChatId =
            newChatId;

        messages =
            chatStore.chats[newChatId].messages;

        renderChatList();

        chat.innerHTML = "";
        promptBox.focus();
    }
);

async function clearConversation(chatId) {
    const epoch = sessionEpoch;
    const target = chatStore.chats[chatId];
    if (!loginScreen.hidden || !target || target.lifecyclePending) return;

    const confirmedClear = typeof terminalConfirm === "function"
        ? await terminalConfirm('Clear the history for "' + target.title + '"?', "CLEAR MEMORY FILE")
        : confirm('Clear the history for "' + target.title + '"?');

    if (!confirmedClear) return;
    target.lifecyclePending = true;
    target.historyRevision = (target.historyRevision || 0) + 1;
    invalidateGeneration(chatId);
    delete target.transientResponse;
    try {
        const response = await fetch('/api/chats/' + encodeURIComponent(chatId) + '/messages',
            { method: "DELETE", credentials: "same-origin" });
        if (epoch !== sessionEpoch || chatStore.chats[chatId] !== target) return;
        if (!response.ok) throw new Error("HTTP " + response.status);
        const result = await response.json();
        if (epoch !== sessionEpoch || chatStore.chats[chatId] !== target) return;
        target.serverRevision = requireServerRevision(result.revision);
        target.lifecyclePending = false;
        target.messages = [];
        if (chatStore.activeChatId === chatId) {
            messages = target.messages;
            restoreChat();
        }
        renderChatList();
    } catch (error) {
        if (epoch !== sessionEpoch || chatStore.chats[chatId] !== target) return;
        console.error("Could not clear chat:", error);
        await reconcileConversation(chatId);
    }
}
deleteChatButton.addEventListener("click", () => clearConversation(chatStore.activeChatId));

stopButton.addEventListener(
    "click",
    () => {
        if (controller) {
            controller.abort();
        }
    }
);

let scrollSaveTimer;

chat.addEventListener("scroll", () => {
    const activeChatId = chatStore.activeChatId;

    const activeChat =
        chatStore.chats[
            activeChatId
    ];

    if (!activeChat) return;

    activeChat.scrollTop =
        chat.scrollTop;

    clearTimeout(scrollSaveTimer);

    scrollSaveTimer = setTimeout(() => {
        fetch(
    `/api/chats/${encodeURIComponent(activeChatId)}/scroll`,
    {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            scrollTop: Math.round(activeChat.scrollTop)
        })
    }
).then((response) => {
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
}).catch((error) => {
    console.error("Could not save chat scroll position:", error);
});
    }, 300);
});

checkHealth();
promptBox.focus();

async function fetchServerChats() {
    const response = await fetch("/api/chats", {
        credentials: "same-origin",
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(`Could not load chats: HTTP ${response.status}`);
    }

    return response.json();
}

async function prepareServerChatStore() {
    const epoch = sessionEpoch;
    const sequence = ++historyLoadSequence;
    const store = chatStore;
    const initialState = Object.entries(store.chats).map(([id, c]) => ({
        id, chat: c, historyRevision: c.historyRevision, serverRevision: c.serverRevision,
        messages: c.messages, length: c.messages.length, pending: c.lifecyclePending,
        title: c.title, scrollTop: c.scrollTop
    }));
    const isCurrent = () => epoch === sessionEpoch && sequence === historyLoadSequence &&
        chatStore === store && Object.keys(store.chats).length === initialState.length &&
        initialState.every(s => store.chats[s.id] === s.chat && s.chat.historyRevision === s.historyRevision &&
            s.chat.serverRevision === s.serverRevision && s.chat.messages === s.messages &&
            s.messages.length === s.length && s.chat.lifecyclePending === s.pending &&
            s.chat.title === s.title && s.chat.scrollTop === s.scrollTop);
    const serverChats = await fetchServerChats();
    if (epoch !== sessionEpoch) throw new Error("Session changed");
    const chats = {};

    for (const serverChat of serverChats) {
        requireServerRevision(serverChat.revision);
        if (epoch !== sessionEpoch) throw new Error("Session changed");
        const response = await fetch(
            `/api/chats/${encodeURIComponent(serverChat.id)}/messages`,
            {
                credentials: "same-origin",
                cache: "no-store"
            }
        );

        if (!response.ok) {
            throw new Error(
                `Could not load messages: HTTP ${response.status}`
            );
        }

        const snapshot = await readHistorySnapshot(response);
        chats[serverChat.id] = {
            title: serverChat.title,
            messages: snapshot.messages,
            serverRevision: snapshot.serverRevision,
            scrollTop: serverChat.scroll_top ?? 0
        };
    }

    if (!isCurrent()) throw new Error("Chat state changed while loading");
    return { chats, isCurrent };
}

async function inspectServerChats() {
    const chats = await fetchServerChats();

    console.log(
        "Server chats:",
        chats.map(chat => ({
            id: chat.id,
            title: chat.title
        }))
    );
}

async function checkLogin() {
    const epoch = sessionEpoch;
    try {
        const response = await fetch("/api/me", {
            credentials: "same-origin",
            cache: "no-store"
        });
        if (epoch !== sessionEpoch) return;

        loginScreen.hidden = false;
        if (response.ok) {
    const user = await response.json();
        if (epoch !== sessionEpoch) return;
    adminConsoleButton.hidden = user.isAdmin !== true;

    try {
        await loadUserSettings();
        if (epoch !== sessionEpoch) return;
        await loadAiRuntime();
        if (epoch !== sessionEpoch) return;

    const prepared = await prepareServerChatStore();
        if (epoch !== sessionEpoch) return;
    if (!prepared.isCurrent()) return;
    const chatIds = Object.keys(prepared.chats);

    chatStore = {
        activeChatId: chatIds[0] ?? null,
        chats: prepared.chats
    };

    messages = chatStore.activeChatId
        ? chatStore.chats[chatStore.activeChatId].messages
        : [];

    renderChatList();

    if (chatStore.activeChatId) {
        restoreChat();
    } else {
        chat.innerHTML = "";
    }

    loginScreen.hidden = true;
} catch (error) {
        if (epoch !== sessionEpoch) return;
    console.error("Could not load server chats:", error);
    loginScreen.hidden = false;
}
} else {
    adminConsoleButton.hidden = true;
}
    } catch (error) {
        if (epoch !== sessionEpoch) return;
        console.error("Authentication check failed:", error);
        loginScreen.hidden = false;
    }
}

checkLogin();

const loginScreen = document.getElementById("loginScreen");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const adminConsoleButton = document.getElementById("adminConsoleButton");

adminConsoleButton.addEventListener("click", () => {
    window.open("/admin", "_blank", "noopener");
});

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    replaceSession();
    const epoch = sessionEpoch;

    loginError.hidden = true;

    const username = document.getElementById("loginUsername").value;
    const passwordInput = document.getElementById("loginPassword");

    try {
        const response = await fetch("/api/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "same-origin",
            body: JSON.stringify({
                username,
                password: passwordInput.value
            })
        });
        if (epoch !== sessionEpoch) return;

        if (!response.ok) {
            throw new Error("Invalid username or password");
        }

        const user = await response.json();
        if (epoch !== sessionEpoch) return;

        await loadUserSettings();
        if (epoch !== sessionEpoch) return;
        await loadAiRuntime();
        if (epoch !== sessionEpoch) return;

        chatStore = { activeChatId: null, chats: {} };  
        messages = [];
        chat.innerHTML = "";
        chatList.innerHTML = "";
        updateActiveChatTitle();
        updateDeleteChatButtonState();

        passwordInput.value = "";
        await checkLogin();
        if (epoch !== sessionEpoch) return;

        console.log("Login successful:", user.username);
    } catch (error) {
        if (epoch !== sessionEpoch) return;
        loginError.textContent = error.message;
        loginError.hidden = false;
        passwordInput.value = "";
    }
});

const logoutButton = document.getElementById("logoutButton");

logoutButton.addEventListener("click", async () => {
    replaceSession();
    loginScreen.hidden = false;
    const epoch = sessionEpoch;
    try {
        const response = await fetch("/api/logout", {
            method: "POST",
            credentials: "same-origin"
        });
        if (epoch !== sessionEpoch) return;

        if (!response.ok) {
            throw new Error("Logout failed");
        }

        chatStore = { activeChatId: null, chats: {} };
        messages = [];
        chat.innerHTML = "";
        chatList.innerHTML = "";
        updateActiveChatTitle();
        updateDeleteChatButtonState();
        document.getElementById("loginPassword").value = "";
        loginScreen.hidden = false;
        adminConsoleButton.hidden = true;
    } catch (error) {
        if (epoch !== sessionEpoch) return;
        console.error("Logout failed:", error);
        if (typeof terminalAlert === "function") {
            await terminalAlert("Could not log out. Please try again.", "LINK ERROR");
        } else {
            alert("Could not log out. Please try again.");
        }
    }
});
