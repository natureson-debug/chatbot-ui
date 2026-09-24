const HOST = "0.0.0.0";
const PORT = 3000;

const LLAMA_URL = "http://192.168.100.1:8080/v1/chat/completions";
const LLAMA_HEALTH_URL = "http://192.168.100.1:8080/health";
const API_KEY_FILE = "C:\\AI\\config\\llama-api-key.txt";
const AI_CONFIG_FILE = "C:\\AI\\config\\chatbot-ai-config.json";
const MODELS_DIR = "C:\\AI\\models";

module.exports = {
    HOST,
    PORT,
    LLAMA_URL,
    LLAMA_HEALTH_URL,
    API_KEY_FILE,
    AI_CONFIG_FILE,
    MODELS_DIR
};
