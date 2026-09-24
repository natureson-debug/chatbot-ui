const fs = require("fs");
const { LLAMA_URL, LLAMA_HEALTH_URL, API_KEY_FILE } = require("./config");

const apiKey = fs.readFileSync(API_KEY_FILE, "utf8").trim();

async function createChatCompletion(llamaRequest) {
    return fetch(LLAMA_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(llamaRequest)
    });
}

async function getHealth() {
    const response = await fetch(LLAMA_HEALTH_URL, {
        headers: {
            "Authorization": `Bearer ${apiKey}`
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
}

module.exports = { createChatCompletion, getHealth };
