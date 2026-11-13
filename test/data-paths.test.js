'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { resolveDataPaths: resolve } = require('../core/data-paths');
const windows = { platform: 'win32', mode: 'per-user', home: 'C:\\Users\\fixture', installationRoot: 'C:\\Program Files\\Chatbot' };
const linux = { platform: 'linux', mode: 'per-user', home: '/home/fixture', installationRoot: '/opt/chatbot' };

test('explicit data root and database override have documented precedence', () => {
    const result = resolve({ ...windows, env: { CHATBOT_DATA_ROOT: 'D:\\ChatData', CHATBOT_DB_PATH: 'E:\\existing.db', LOCALAPPDATA: 'C:\\unused' } });
    assert.equal(result.dataRoot, 'D:\\ChatData');
    assert.equal(result.database, 'E:\\existing.db');
    assert.equal(result.providerConfig, 'D:\\ChatData\\config\\chatbot-connections.json');
    assert.equal(result.installationRoot, windows.installationRoot);
    assert(Object.isFrozen(result));
});
test('legacy Windows preserves the actual split storage layout', () => {
    const result = resolve({ ...windows, mode: 'legacy-windows', installationRoot: 'C:\\AI\\chatbot-ui' });
    assert.equal(result.database, 'C:\\AI\\chatbot-ui\\data\\chatbot.db');
    assert.equal(result.attachments, 'C:\\AI\\chatbot-ui\\data\\attachments');
    assert.equal(result.localApiKey, 'C:\\AI\\config\\llama-api-key.txt');
    assert.equal(result.protectedCredentials, 'C:\\AI\\config\\protected-credentials');
});
test('existing CHATBOT_HOME does not relocate the legacy database or attachments', () => {
    const result = resolve({ ...windows, mode: 'legacy-windows', env: { CHATBOT_HOME: 'D:\\existing' } });
    assert.equal(result.extensionsConfig, 'D:\\existing\\config\\chatbot-extensions.json');
    assert.equal(result.database, 'C:\\Program Files\\Chatbot\\data\\chatbot.db');
    assert.equal(result.models, 'D:\\existing\\models');
});
test('Windows per-user uses LOCALAPPDATA or explicit home', () => {
    assert.equal(resolve({ ...windows, env: { LOCALAPPDATA: 'D:\\Local' } }).dataRoot, 'D:\\Local\\AIChatbot');
    assert.equal(resolve(windows).dataRoot, 'C:\\Users\\fixture\\AppData\\Local\\AIChatbot');
});
test('macOS uses Application Support, not Windows legacy paths', () => {
    const result = resolve({ ...linux, platform: 'darwin', home: '/Users/fixture' });
    assert.equal(result.dataRoot, '/Users/fixture/Library/Application Support/AIChatbot');
    assert.equal(result.database, result.dataRoot + '/data/chatbot.db');
});
test('Linux uses XDG_DATA_HOME or the standard per-user data directory', () => {
    assert.equal(resolve({ ...linux, env: { XDG_DATA_HOME: '/srv/user-data' } }).dataRoot, '/srv/user-data/aichatbot');
    assert.equal(resolve(linux).dataRoot, '/home/fixture/.local/share/aichatbot');
});
test('ambiguous mode, unsupported platform and foreign legacy mode fail closed', () => {
    for (const options of [{ ...windows, mode: undefined }, { ...linux, mode: 'legacy-windows' }, { ...linux, platform: 'other' }]) {
        assert.throws(() => resolve(options), { code: 'APP_DATA_PATH_INVALID' });
    }
});
test('invalid explicit paths are rejected without exposing their values', () => {
    for (const value of ['', ' ', 'relative/secret', 'C:secret', '\\secret', 'C:\\secret\n', 'C:\\secret?']) {
        assert.throws(() => resolve({ ...windows, env: { CHATBOT_DATA_ROOT: value } }), error => error.code === 'APP_DATA_PATH_INVALID' && !error.message.includes('secret'));
    }
    for (const key of ['CHATBOT_HOME', 'CHATBOT_DB_PATH', 'LOCALAPPDATA']) {
        assert.throws(() => resolve({ ...windows, env: { [key]: '' } }), { code: 'APP_DATA_PATH_INVALID' });
    }
    assert.throws(() => resolve({ ...linux, env: { XDG_DATA_HOME: 'relative' } }));
    assert.throws(() => resolve({ ...linux, env: { CHATBOT_HOME: 'C:\\AI' } }));
});
test('conflicting root aliases are rejected; equivalent Windows paths are accepted', () => {
    assert.throws(() => resolve({ ...windows, env: { CHATBOT_HOME: 'C:\\one', CHATBOT_DATA_ROOT: 'D:\\two' } }));
    assert.equal(resolve({ ...windows, env: { CHATBOT_HOME: 'C:\\same', CHATBOT_DATA_ROOT: 'c:/same' } }).source, 'CHATBOT_DATA_ROOT');
});
test('resolution imports only path, with no filesystem or SQLite access', () => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../core/data-paths.js'), 'utf8'), {
        module, require(id) { assert.equal(id, 'node:path'); return path; }
    });
    assert.equal(module.exports.resolveDataPaths(linux).database, resolve(linux).database);
});
test('resolving absent roots never creates directories or a database', t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'data-paths-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const absent = path.join(temporary, 'absent');
    const result = resolve({ platform: process.platform, mode: 'per-user', installationRoot: temporary, env: { CHATBOT_DATA_ROOT: absent } });
    assert.equal(fs.existsSync(result.database), false);
    assert.equal(fs.existsSync(absent), false);
    assert.deepEqual(fs.readdirSync(temporary), []);
});
