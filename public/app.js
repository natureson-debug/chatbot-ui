const chat = document.getElementById("chat");
const promptBox = document.getElementById("prompt");
const sendButton = document.getElementById("send");
const stopButton = document.getElementById("stop");
const newChatButton = document.getElementById("newChat");
const thinkingToggle = document.getElementById("thinking");
const systemPromptBox = document.getElementById("systemPrompt");
const temperatureInput = document.getElementById("temperature");
const maxTokensInput = document.getElementById("maxTokens");
const statusText = document.getElementById("status");


systemPromptBox.value =
    localStorage.getItem("systemPrompt") || "";
    
temperatureInput.value =
    localStorage.getItem("temperature") || "0.7";

maxTokensInput.value =
    localStorage.getItem("maxTokens") || "512";

thinkingToggle.checked =
    localStorage.getItem("thinking") === "true";    

let messages = [];
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

    container.appendChild(roleLabel);
    container.appendChild(text);

    chat.appendChild(container);

    chat.scrollTop = chat.scrollHeight;

    return text;
}

async function sendMessage() {
    const prompt = promptBox.value.trim();

    if (!prompt || generating) return;

    generating = true;
    sendButton.disabled = true;

    stopButton.disabled = false;
    controller = new AbortController();

    promptBox.value = "";

    addMessage("user", prompt);

    messages.push({
        role: "user",
        content: prompt
    });

    const assistantElement =
        addMessage("assistant", "");

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
                    ...messages
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
            content: assistantText
        });

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
                    content: assistantText
                });
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

newChatButton.addEventListener(
    "click",
    () => {
        messages = [];
        chat.innerHTML = "";
        promptBox.focus();
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

checkHealth();
promptBox.focus();
