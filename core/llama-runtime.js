if (process.platform !== "win32") {
    throw new Error(`Unsupported llama.cpp runtime platform: ${process.platform}`);
}

module.exports = require("./runtime/windows");
