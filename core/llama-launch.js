const path = require("path");
const { isIP } = require("net");

// Explicit settings are pure: no filesystem, environment or process observations.
// Existence, hashes, ACLs, device availability and binary capability are deployment checks.
function buildLlamaLaunchSpec(settings) {
    if (arguments.length > 0) return buildExplicitSpec(settings);
    return buildConfiguredSpec();
}

function buildExplicitSpec(settings) {
    const fields = new Set(["platform", "executable", "cwd", "modelPath", "apiKeyFile",
        "host", "port", "corsOrigin", "device", "gpuLayers", "contextSize", "parallel", "verbosity"]);
    if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
        Object.keys(settings).some(key => !fields.has(key))) throw new Error("Invalid launch settings");
    const { platform, executable, cwd, modelPath, apiKeyFile, host, port,
        corsOrigin, device, gpuLayers, contextSize, parallel, verbosity } = settings;
    if (!["win32", "linux", "darwin"].includes(platform)) throw new Error("Unsupported launch platform");
    const paths = platform === "win32" ? path.win32 : path.posix;
    const text = value => typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
    for (const value of [executable, cwd, modelPath, apiKeyFile]) {
        if (!text(value) || !paths.isAbsolute(value) ||
            (platform === "win32" && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(value))) {
            throw new Error("Absolute executable, working directory, model and API-key paths are required");
        }
    }
    if (!isIP(host)) throw new Error("A literal bind IP address is required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
    if (!text(corsOrigin)) throw new Error("Invalid CORS origin");
    let origin;
    try { origin = new URL(corsOrigin); } catch (_) { throw new Error("Invalid CORS origin"); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
        origin.search || origin.hash || origin.pathname !== "/") throw new Error("Invalid CORS origin");
    if (!text(device) || !/^[a-z0-9][a-z0-9_.:-]*$/i.test(device)) throw new Error("One explicit device is required");
    if (gpuLayers !== undefined && (!Number.isSafeInteger(gpuLayers) || gpuLayers < 0)) throw new Error("Invalid GPU layer count");
    if (device.toLowerCase() === "none" && gpuLayers > 0) throw new Error("GPU layers conflict with device none");
    if (verbosity !== undefined && (!Number.isSafeInteger(verbosity) || verbosity < 0)) throw new Error("Invalid verbosity");
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error("Invalid parallel slot count");
    if (!Number.isInteger(contextSize) || contextSize < 1024 || contextSize > 131072 || contextSize % 1024 !== 0) {
        throw new Error("Invalid context size");
    }
    const args = ["--model", modelPath, "--host", host, "--port", String(port),
        "--api-key-file", apiKeyFile, "--cors-origins", corsOrigin,
        "--parallel", String(parallel), "--ctx-size", String(contextSize), "--device", device];
    if (gpuLayers !== undefined) args.push("--n-gpu-layers", String(gpuLayers));
    if (verbosity !== undefined) args.push("--verbosity", String(verbosity));
    return {
        executable, cwd, args, env: {},
        expected: { host, port, model: modelPath, device, gpuLayers: gpuLayers ?? null,
            contextSize, parallel, verbosity: verbosity ?? null },
        apiKeyFile
    };
}

// Compatibility wrapper: retain the existing no-argument filesystem-backed API.
function buildConfiguredSpec() {
    const fs = require("fs");
    const {
        AI_CONFIG_FILE, MODELS_DIR, API_KEY_FILE,
        LLAMA_BIND_HOST, LLAMA_PORT, LLAMA_CORS_ORIGIN, LLAMA_DEVICE
    } = require("./config");
    const { LLAMA_EXECUTABLE, LLAMA_CWD } = require("./paths");
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
