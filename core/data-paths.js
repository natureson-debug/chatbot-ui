'use strict';

// Pure path resolution; database startup is the first integrated consumer.
const path = require('node:path');

function resolveDataPaths({ platform, env = {}, home, installationRoot, mode } = {}) {
    const fail = field => {
        const error = new Error(`Invalid application path configuration: ${field}`);
        error.code = 'APP_DATA_PATH_INVALID';
        throw error;
    };
    if (!['win32', 'darwin', 'linux'].includes(platform)) fail('platform');
    if (!env || typeof env !== 'object' || Array.isArray(env)) fail('environment');
    if (!['legacy-windows', 'installation', 'per-user'].includes(mode)) fail('explicit storage mode required');
    if (mode === 'legacy-windows' && platform !== 'win32') fail('legacy mode requires Windows');
    const p = platform === 'win32' ? path.win32 : path.posix;
    function absolute(value, field) {
        if (typeof value !== 'string' || !value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) fail(field);
        if (!p.isAbsolute(value)) fail(field);
        if (platform === 'win32') {
            // Require a drive-rooted path or ordinary UNC path, never device namespaces.
            if (!/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\[^\\/?\.]+\\[^\\/]+/.test(value)) fail(field);
            if (/[<>"|?*]/.test(value) || value.slice(2).includes(':')) fail(field);
        } else if (value.includes('\\') || /^[A-Za-z]:/.test(value)) fail(field);
        return p.normalize(value);
    }
    function optional(name) {
        return Object.hasOwn(env, name) ? absolute(env[name], name) : undefined;
    }
    const install = absolute(installationRoot, 'installationRoot');
    const rootOverride = optional('CHATBOT_DATA_ROOT');
    const legacyOverride = optional('CHATBOT_HOME');
    const dbOverride = optional('CHATBOT_DB_PATH');
    const equal = (a, b) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (rootOverride && legacyOverride && !equal(rootOverride, legacyOverride)) fail('conflicting root overrides');
    let root = rootOverride || legacyOverride;
    let source = rootOverride ? 'CHATBOT_DATA_ROOT' : legacyOverride ? 'CHATBOT_HOME' : mode;
    if (!root) {
        if (mode === 'installation') root = install;
        else if (mode === 'legacy-windows') root = 'C:\\AI';
        else if (platform === 'win32') root = p.join(optional('LOCALAPPDATA') || p.join(absolute(home, 'home'), 'AppData', 'Local'), 'Renitech', 'Chatbot');
        else if (platform === 'darwin') root = p.join(absolute(home, 'home'), 'Library', 'Application Support', 'Renitech', 'Chatbot');
        else root = p.join(optional('XDG_DATA_HOME') || p.join(absolute(home, 'home'), '.local', 'share'), 'renitech-chatbot');
    }
    // Legacy CHATBOT_HOME never relocated the installation-relative database or attachments.
    const persistent = mode !== 'per-user' ? p.join(install, 'data') : p.join(root, 'data');
    const config = p.join(root, 'config');
    return Object.freeze({
        mode, source, installationRoot: install, dataRoot: root,
        database: dbOverride || p.join(persistent, 'chatbot.db'),
        attachments: p.join(persistent, 'attachments'),
        providerConfig: p.join(config, 'chatbot-connections.json'),
        extensionsConfig: p.join(config, 'chatbot-extensions.json'),
        protectedCredentials: p.join(config, 'protected-credentials'),
        // Proposed diagnostics directory; system events remain inside SQLite.
        diagnostics: p.join(root, 'logs'),
        localRuntimeConfig: p.join(config, 'chatbot-ai-config.json'),
        localApiKey: p.join(config, 'llama-api-key.txt'),
        // Models and executables are external resources, not created or bundled here.
        models: p.join(root, 'models'),
        localEngineDirectory: p.join(root, 'llama.cpp')
    });
}

function resolveStoragePaths(installationRoot, { env = {}, platform = process.platform, home = require('node:os').homedir() } = {}) {
    const mode = Object.hasOwn(env, 'CHATBOT_STORAGE_MODE')
        ? env.CHATBOT_STORAGE_MODE : platform === 'win32' ? 'legacy-windows' : 'installation';
    return resolveDataPaths({ platform, env, home, installationRoot, mode });
}
module.exports = { resolveDataPaths, resolveStoragePaths };
