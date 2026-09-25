const path = require("path");
const os = require("os");

const homeOverride = process.env.CHATBOT_HOME;
let chatbotRoot = homeOverride && homeOverride.trim() ? homeOverride : null;
let platformPath;

switch (process.platform) {
    case "win32":
        platformPath = path.win32;
        chatbotRoot = chatbotRoot || "C:\\AI";
        break;
    case "linux":
        platformPath = path.posix;
        chatbotRoot = chatbotRoot || platformPath.join(os.homedir(), ".chatbot");
        break;
    case "darwin":
        platformPath = path.posix;
        chatbotRoot = chatbotRoot || platformPath.join(os.homedir(), "Library", "Application Support", "Chatbot");
        break;
    default:
        throw new Error(`Unsupported Chatbot paths platform: ${process.platform}`);
}

const CONFIG_DIR = platformPath.join(chatbotRoot, "config");

const API_KEY_FILE = platformPath.join(CONFIG_DIR, "llama-api-key.txt");
const AI_CONFIG_FILE = platformPath.join(CONFIG_DIR, "chatbot-ai-config.json");
const MODELS_DIR = platformPath.join(chatbotRoot, "models");
const LLAMA_CWD = platformPath.join(chatbotRoot, "llama.cpp");
const LLAMA_EXECUTABLE = platformPath.join(LLAMA_CWD, "llama-server.exe");

module.exports = {
    API_KEY_FILE,
    AI_CONFIG_FILE,
    MODELS_DIR,
    LLAMA_CWD,
    LLAMA_EXECUTABLE
};
