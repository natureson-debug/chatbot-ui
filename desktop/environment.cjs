'use strict';
const path = require('node:path');
function desktopEnvironment(root, inherited = {}) {
    if (!path.isAbsolute(root) || root.includes('\0')) throw new Error('DESKTOP_DATA_ROOT_INVALID');
    // Do not inherit Windows/another installation's application path overrides.
    const env = { ...inherited, CHATBOT_STORAGE_MODE: 'per-user', CHATBOT_HOME: root,
        CHATBOT_DATA_ROOT: root, CHATBOT_DB_PATH: path.join(root, 'data', 'chatbot.db'), CHATBOT_PORT: '3000' };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    return env;
}
module.exports = { desktopEnvironment };
