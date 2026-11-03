const { API_KEY_FILE, AI_CONFIG_FILE, MODELS_DIR } = require("./paths");

const HOST = "127.0.0.1";
const PORT = (() => {
    const raw = process.env.CHATBOT_PORT;
    if (raw === undefined || raw === "") return 3000;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("CHATBOT_PORT must be an integer from 1 to 65535");
    }
    return port;
})();

const LLAMA_BIND_HOST = "127.0.0.1";
const LLAMA_PORT = 8080;
const LLAMA_BASE_URL = `http://${LLAMA_BIND_HOST}:${LLAMA_PORT}`;
const LLAMA_URL = `${LLAMA_BASE_URL}/v1/chat/completions`;
const LLAMA_HEALTH_URL = `${LLAMA_BASE_URL}/health`;
const LLAMA_CORS_ORIGIN = LLAMA_BASE_URL;
const LLAMA_DEVICE = "CUDA0";

module.exports = {
    HOST,
    PORT,
    LLAMA_URL,
    LLAMA_HEALTH_URL,
    LLAMA_BIND_HOST,
    LLAMA_PORT,
    LLAMA_CORS_ORIGIN,
    LLAMA_DEVICE,
    API_KEY_FILE,
    AI_CONFIG_FILE,
    MODELS_DIR
};
