const fs = require("fs");
const { LLAMA_URL, LLAMA_HEALTH_URL, API_KEY_FILE } = require("./config");

const apiKey = fs.readFileSync(API_KEY_FILE, "utf8").trim();

async function createChatCompletion(llamaRequest, { signal } = {}) {
    return fetch(LLAMA_URL, {
        method: "POST",
        signal,
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(llamaRequest)
    });
}

async function getHealth({ signal } = {}) {
    const response = await fetch(LLAMA_HEALTH_URL, {
        signal,
        headers: {
            "Authorization": `Bearer ${apiKey}`
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
}

async function getReportedModel() {
    const response = await fetch(new URL("/v1/models", LLAMA_URL), {
        signal: AbortSignal.timeout(3000),
        headers: { "Authorization": `Bearer ${apiKey}` }
    });
    if (!response.ok) throw new Error("Model observation unavailable");
    const result = await response.json();
    return Array.isArray(result.data) && result.data.length === 1 &&
        typeof result.data[0].id === "string" && result.data[0].id.length > 0 ? result.data[0].id : null;
}
module.exports = { createChatCompletion, getHealth, getReportedModel };
