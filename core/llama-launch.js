const fs = require("fs");
const path = require("path");
const {
    AI_CONFIG_FILE, MODELS_DIR, API_KEY_FILE,
    LLAMA_BIND_HOST, LLAMA_PORT, LLAMA_CORS_ORIGIN, LLAMA_DEVICE
} = require("./config");
const { LLAMA_EXECUTABLE, LLAMA_CWD } = require("./paths");

function buildLlamaLaunchSpec() {
    // Only the existing Windows launch configuration is defined at this stage.
    if (process.platform !== "win32") {
        throw new Error(`Unsupported llama.cpp launch platform: ${process.platform}`);
    }

    const config = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, "utf8"));

    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("Invalid AI configuration");
    }

    const { model, parallel, contextSize } = config;
    const availableModels = fs.readdirSync(MODELS_DIR)
        .filter(file => file.toLowerCase().endsWith(".gguf"));

    if (typeof model !== "string" || !availableModels.includes(model)) {
        throw new Error("Invalid AI model");
    }

    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) {
        throw new Error("Invalid parallel slot count");
    }

    if (
        !Number.isInteger(contextSize) ||
        contextSize < 1024 ||
        contextSize > 131072 ||
        contextSize % 1024 !== 0
    ) {
        throw new Error("Invalid context size");
    }

    return {
        executable: LLAMA_EXECUTABLE,
        cwd: LLAMA_CWD,
        args: [
            "--model", path.win32.join(MODELS_DIR, model),
            "--host", LLAMA_BIND_HOST,
            "--port", String(LLAMA_PORT),
            "--api-key-file", API_KEY_FILE,
            "--cors-origins", LLAMA_CORS_ORIGIN,
            "--parallel", String(parallel),
            "--ctx-size", String(contextSize),
            "--device", LLAMA_DEVICE
        ]
    };
}

module.exports = { buildLlamaLaunchSpec };
