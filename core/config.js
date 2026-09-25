const { API_KEY_FILE, AI_CONFIG_FILE, MODELS_DIR } = require("./paths");

const HOST = "0.0.0.0";
const PORT = 3000;

const LLAMA_URL = "http://192.168.100.1:8080/v1/chat/completions";
const LLAMA_HEALTH_URL = "http://192.168.100.1:8080/health";
const LLAMA_BIND_HOST = "192.168.100.1";
const LLAMA_PORT = 8080;
const LLAMA_CORS_ORIGIN = "http://192.168.100.1:8080";
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
