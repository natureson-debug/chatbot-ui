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
        alert("Please select a .txt file no larger than 100 KB.");
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


systemPromptBox.value =
    localStorage.getItem("systemPrompt") || "";
    
temperatureInput.value =
    localStorage.getItem("temperature") || "0.7";

maxTokensInput.value =
    localStorage.getItem("maxTokens") || "4096";

thinkingToggle.checked =
    localStorage.getItem("thinking") === "true";    

let chatStore =
    JSON.parse(
        localStorage.getItem("chatStore")
    ) || {
        activeChatId: "chat-1",
        chats: {
            "chat-1": {
                title: "Chat 1",
                messages: JSON.parse(
                    localStorage.getItem("chatMessages")
                ) || []
            }
        }
    };

let messages =
    chatStore.chats[chatStore.activeChatId]?.messages ?? [];

chat.innerHTML = "";
chatList.innerHTML = "";

let generating = false;
let controller = null;

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

function addMessage(role, content = "") {
    const container = document.createElement("div");
    container.className = `message ${role}`;

    const roleLabel = document.createElement("div");
    roleLabel.className = "role";
    roleLabel.textContent =
        role === "user" ? "You" : "Qwen";

    const text = document.createElement("div");
    text.textContent = content;

    const telemetry = document.createElement("div");
    telemetry.className = "telemetry";  

    container.appendChild(roleLabel);
    container.appendChild(text);

    if (role === "assistant") {
    container.appendChild(telemetry);
    }

    chat.appendChild(container);

    chat.scrollTop = chat.scrollHeight;

    return {text, telemetry};
}

function restoreChat() {
    chat.innerHTML = "";

    messages.forEach((message) => {
        const restoredMessage =
    addMessage(
        message.role,
        message.displayContent ?? message.content
    );

            const savedScrollTop =
    chatStore.chats[chatStore.activeChatId]?.scrollTop ?? 0;

chat.scrollTop = savedScrollTop;

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

    const requestedTitle = prompt(
        "Enter a chat name (maximum 100 characters):",
        chatData.title
    );

    if (requestedTitle === null) return;

    const trimmedTitle = requestedTitle.trim();

    if (!trimmedTitle) {
        alert("Chat name cannot be empty.");
        return;
    }

    if (trimmedTitle.length > 100) {
        alert("Chat name must be 100 characters or fewer.");
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
    alert("Could not rename the chat. Please try again.");
    return;
}

    localStorage.setItem(
        "chatStore",
        JSON.stringify(chatStore)
    );

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

                        localStorage.setItem(
                            "chatStore",
                            JSON.stringify(chatStore)
                        );

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
    closeChatContextMenu();
    deleteChatButton.click();
});

const deleteChatAction = document.getElementById("deleteChatAction");

deleteChatAction.addEventListener("click", async () => {
    const chatId = chatStore.activeChatId;
    const activeChat = chatStore.chats[chatId];

    closeChatContextMenu();

    if (!loginScreen.hidden || !activeChat) return;

    if (!confirm(`Delete "${activeChat.title}" and all its messages?`)) {
        return;
    }

    try {
        const response = await fetch(
            `/api/chats/${encodeURIComponent(chatId)}`,
            { method: "DELETE", credentials: "same-origin" }
        );

        if (!response.ok) {
            throw new Error(`Delete chat failed: HTTP ${response.status}`);
        }

        delete chatStore.chats[chatId];

        chatStore.activeChatId =
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
        console.error("Could not delete chat:", error);
        alert("Could not delete the chat. Please try again.");
    }
});

document.addEventListener("click", (event) => {
    if (!chatContextMenu.hidden && !chatContextMenu.contains(event.target)) {
        closeChatContextMenu();
    }
});

window.addEventListener("resize", closeChatContextMenu);


async function sendMessage() {
    if (!loginScreen.hidden || !chatStore.activeChatId) {
    return;
}
    const prompt = promptBox.value.trim();

    if (!prompt || generating) return;

    const attachment = await readSelectedAttachment();

    if (attachment) {
        console.log("Attachment ready:", {
            name: attachment.name,
            characters: attachment.content.length
    });
}

const messageContent = attachment
    ? `${prompt}\n\nAttached file: ${attachment.name}\n\n${attachment.content}`
    : prompt;

    document
    .querySelectorAll(".telemetry.active")
    .forEach((element) => {
        element.classList.remove("active");
    });

    generating = true;
    sendButton.disabled = true;

    stopButton.disabled = false;
    controller = new AbortController();

    promptBox.value = "";
    attachmentInput.value = "";
    attachmentName.textContent = "";
    attachmentName.hidden = true;
    removeAttachmentButton.hidden = true;

    addMessage(
    "user",
    attachment
        ? `${prompt}\n\nAttached file: ${attachment.name}`
        : prompt
    );

    messages.push({
        role: "user",
        content: messageContent
    });

try {
    const response = await fetch(
        `/api/chats/${encodeURIComponent(chatStore.activeChatId)}/messages`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
    role: "user",
    content: messageContent,
    displayContent: attachment
        ? `${prompt}\n\nAttached file: ${attachment.name}`
        : null
})
        }
    );

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
} catch (error) {
    console.error("Could not save user message to SQLite:", error);
}

    localStorage.setItem(
        "chatStore",
        JSON.stringify(chatStore)
    );

    renderChatList();

    const assistantMessage =
        addMessage("assistant");

    const assistantElement =
        assistantMessage.text;

    const telemetryElement = 
        assistantMessage.telemetry;

    let responseTelemetry = null;

    let assistantText = "";

    try {
        statusText.textContent = "Generating...";

        const response = await fetch("/api/chat", {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                messages: [
                    {
                        role: "system",
                        content: systemPromptBox.value.trim()
                    },
                    ...messages.map((message) => ({
                        role: message.role,
                        content: message.content
                }))
                ],
                enable_thinking: thinkingToggle.checked,
                temperature: Number(temperatureInput.value),
                max_tokens: Number(maxTokensInput.value)
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(
                await response.text()
            );
        }

        const reader =
            response.body.getReader();

        const decoder =
            new TextDecoder();

        let buffer = "";

        while (true) {
            const { done, value } =
                await reader.read();

            if (done) break;

            buffer += decoder.decode(
                value,
                { stream: true }
            );

            const lines =
                buffer.split("\n");

            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();

                if (!trimmed.startsWith("data:")) {
                    continue;
                }

                const data =
                    trimmed.slice(5).trim();

                if (data === "[DONE]") {
                    continue;
                }

                try {
                    const chunk =
                        JSON.parse(data);

                        if (chunk.timings) {
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

                            const contextLimit = 49152;

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

                    if (delta?.content) {
                        assistantText +=
                            delta.content;

                        assistantElement.innerHTML =
                            DOMPurify.sanitize(
                                marked.parse(assistantText)
                            );

                        chat.scrollTop =
                            chat.scrollHeight;
                    }

                } catch (error) {
                    console.error(
                        "Invalid SSE chunk",
                        error
                    );
                }
            }
        }

        messages.push({
            role: "assistant",
            content: assistantText,
            telemetry: responseTelemetry
        });

try {
    const response = await fetch(
        `/api/chats/${encodeURIComponent(chatStore.activeChatId)}/messages`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                role: "assistant",
                content: assistantText,
                telemetry: responseTelemetry
            })
        }
    );

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
} catch (error) {
    console.error("Could not save assistant message to SQLite:", error);
}

        localStorage.setItem(
            "chatStore",
            JSON.stringify(chatStore)
        );

        statusText.textContent = "Connected";

    } catch (error) {
        if (error.name === "AbortError") {
            assistantElement.innerHTML =
                DOMPurify.sanitize(
                    marked.parse(assistantText)
                );
            if (assistantText) {
                messages.push({
                    role: "assistant",
                    content: assistantText,
                    telemetry: responseTelemetry
                });

try {
    const response = await fetch(
        `/api/chats/${encodeURIComponent(chatStore.activeChatId)}/messages`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                role: "assistant",
                content: assistantText,
                telemetry: responseTelemetry
            })
        }
    );

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
} catch (saveError) {
    console.error(
        "Could not save stopped assistant message to SQLite:",
        saveError
    );
}

            localStorage.setItem(
                "chatStore",
                JSON.stringify(chatStore)
            );

            }
            statusText.textContent = "Stopped";
        } else {
            assistantElement.textContent =
                `Error: ${error.message}`;

            statusText.textContent = "Error";
        }

    } finally {
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

systemPromptBox.addEventListener(
    "input",
    () => {
        localStorage.setItem(
            "systemPrompt",
            systemPromptBox.value
        );
    }
);

temperatureInput.addEventListener(
    "input",
    () => {
        localStorage.setItem(
            "temperature",
            temperatureInput.value
        );
    }
);

maxTokensInput.addEventListener(
    "input",
    () => {
        localStorage.setItem(
            "maxTokens",
            maxTokensInput.value
        );
    }
);

thinkingToggle.addEventListener(
    "change",
    () => {
        localStorage.setItem(
            "thinking",
            thinkingToggle.checked
        );
    }
);

settingsToggle.addEventListener("click", () => {
    const isHidden = settingsPanel.hidden;
    settingsPanel.hidden = !isHidden;
    settingsToggle.setAttribute("aria-expanded", String(!isHidden));
    settingsToggle.textContent = isHidden ? "Close settings" : "Settings";
});

newChatButton.addEventListener(
    "click",
    async () => {
        if (!loginScreen.hidden) {
    return;
}
        let newChatId;
        let newChatTitle;

try {
    const response = await fetch("/api/chats", {
        method: "POST"
    });

    if (!response.ok) {
        throw new Error(`Chat creation failed: HTTP ${response.status}`);
    }

    const createdChat = await response.json();
    newChatId = createdChat.id;
    newChatTitle = createdChat.title;
} catch (error) {
    console.error("Could not create chat:", error);
    alert("Could not create a new chat. Please try again.");
    return;
}

        chatStore.chats[newChatId] = {
            title: newChatTitle,
            messages: []
        };

        chatStore.activeChatId =
            newChatId;

        messages =
            chatStore.chats[newChatId].messages;

        localStorage.setItem(
            "chatStore",
            JSON.stringify(chatStore)
        );

        renderChatList();

        chat.innerHTML = "";
        promptBox.focus();
    }
);

deleteChatButton.addEventListener(
    "click",
    async () => {
        if (!loginScreen.hidden || !chatStore.activeChatId) {
    return;
}
        const chatIds =
            Object.keys(chatStore.chats);

        const activeChatId =
            chatStore.activeChatId;

        const activeChat =
            chatStore.chats[activeChatId];

        if (activeChat) {
            const confirmed =
                confirm(
                    `Clear the history for "${activeChat.title}"?\n\nThis will remove all messages in this chat, but it will not delete the chat itself.`
                );

            if (!confirmed) {
                return;
            }

try {
    const response = await fetch(
        `/api/chats/${encodeURIComponent(activeChatId)}/messages`,
        { method: "DELETE", credentials: "same-origin" }
    );

    if (!response.ok) {
        throw new Error(`Clear chat failed: HTTP ${response.status}`);
    }
} catch (error) {
    console.error("Could not clear chat:", error);
    alert("Could not clear the chat. Please try again.");
    return;
}

            activeChat.messages = [];
            messages = activeChat.messages;

            localStorage.setItem(
                "chatStore",
                JSON.stringify(chatStore)
            );

            restoreChat();
            renderChatList();
            return;
        }

        const confirmed =
            confirm(`Delete "${activeChat.title}"?`
            );

        if (!confirmed) {
            return;
        }

        delete chatStore.chats[activeChatId];

        const remainingChatIds =
            Object.keys(chatStore.chats);

        chatStore.activeChatId =
            remainingChatIds[0];

        messages =
            chatStore.chats[
                chatStore.activeChatId
            ].messages;

        localStorage.setItem(
            "chatStore",
            JSON.stringify(chatStore)
        );

        restoreChat();

        renderChatList();
    }
);

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
    const activeChat =
        chatStore.chats[
            chatStore.activeChatId
        ];

    if (!activeChat) return;

    activeChat.scrollTop =
        chat.scrollTop;

    clearTimeout(scrollSaveTimer);

    scrollSaveTimer = setTimeout(() => {
        localStorage.setItem(
            "chatStore",
            JSON.stringify(chatStore)
        );
        fetch(
    `/api/chats/${encodeURIComponent(chatStore.activeChatId)}/scroll`,
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
    const serverChats = await fetchServerChats();
    const chats = {};

    for (const serverChat of serverChats) {
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

        chats[serverChat.id] = {
            title: serverChat.title,
            messages: await response.json(),
            scrollTop: serverChat.scroll_top ?? 0
        };
    }

    return { chats };
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
    try {
        const response = await fetch("/api/me", {
            credentials: "same-origin",
            cache: "no-store"
        });

        loginScreen.hidden = false;
        if (response.ok) {
    const user = await response.json();
    adminConsoleButton.hidden = user.isAdmin !== true;
    try {
    const prepared = await prepareServerChatStore();
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
    console.error("Could not load server chats:", error);
    loginScreen.hidden = false;
}
} else {
    adminConsoleButton.hidden = true;
}
    } catch (error) {
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

        if (!response.ok) {
            throw new Error("Invalid username or password");
        }

        const user = await response.json();
        chatStore = { activeChatId: null, chats: {} };
        messages = [];
        chat.innerHTML = "";
        chatList.innerHTML = "";
        updateActiveChatTitle();
        updateDeleteChatButtonState();

        passwordInput.value = "";
        await checkLogin();

        console.log("Login successful:", user.username);
    } catch (error) {
        loginError.textContent = error.message;
        loginError.hidden = false;
        passwordInput.value = "";
    }
});

const logoutButton = document.getElementById("logoutButton");

logoutButton.addEventListener("click", async () => {
    try {
        const response = await fetch("/api/logout", {
            method: "POST",
            credentials: "same-origin"
        });

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
        console.error("Logout failed:", error);
        alert("Could not log out. Please try again.");
    }
});