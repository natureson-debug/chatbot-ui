const path = require("path");

const AI_ROOT = "C:\\AI";
const CONFIG_DIR = path.win32.join(AI_ROOT, "config");

const API_KEY_FILE = path.win32.join(CONFIG_DIR, "llama-api-key.txt");
const AI_CONFIG_FILE = path.win32.join(CONFIG_DIR, "chatbot-ai-config.json");
const MODELS_DIR = path.win32.join(AI_ROOT, "models");

module.exports = {
    API_KEY_FILE,
    AI_CONFIG_FILE,
    MODELS_DIR
};
