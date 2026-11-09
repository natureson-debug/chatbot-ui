'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { desktopEnvironment } = require('../desktop/environment.cjs');
const { initialize } = require('../desktop/initialize.cjs');
const { launchBackend } = require('../desktop/owned-backend.cjs');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renitech-desktop-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
test('desktop environment pins storage without filesystem changes', t => {
    const root = fixture(t);
    const env = desktopEnvironment(root, { CHATBOT_DB_PATH: 'unrelated', NODE_OPTIONS: '--inspect', NODE_PATH: 'unrelated' });
    assert.equal(env.CHATBOT_DB_PATH, path.join(root, 'data', 'chatbot.db'));
    assert.equal(env.CHATBOT_HOME, root);
    assert.equal(env.CHATBOT_STORAGE_MODE, 'per-user');
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NODE_PATH, undefined);
    assert.deepEqual(fs.readdirSync(root), []);
});
test('explicit initialization creates administrator and refuses replacement', t => {
    const root = fixture(t);
    initialize(root, 'desktop_admin', 'synthetic-fixture-password');
    const file = path.join(root, 'data', 'chatbot.db'), before = fs.readFileSync(file);
    assert.throws(() => initialize(root, 'other_admin', 'synthetic-fixture-password'), /DB_INITIALIZATION_FAILED/);
    assert.deepEqual(fs.readFileSync(file), before);
    const db = new (require('node:sqlite').DatabaseSync)(file, { readOnly: true });
    try {
        const user = db.prepare('SELECT * FROM users').get();
        assert.equal(user.is_admin, 1);
        assert(require('../auth').verifyPassword('synthetic-fixture-password', user.password_hash));
    } finally { db.close(); }
});
test('missing database fails closed', { timeout: 10000 }, async t => {
    const root = fixture(t);
    const backend = launchBackend({ node: process.execPath, root, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
    await assert.rejects(backend.ready, /BACKEND_EXITED/);
    await backend.exit;
    assert(!fs.existsSync(path.join(root, 'data', 'chatbot.db')));
});
test('actual backend readiness, graceful exit and persistent administrator across restart', { timeout: 45000 }, async t => {
    const root = fixture(t);
    initialize(root, 'desktop_admin', 'synthetic-fixture-password');
    let chatId;
    for (let attempt = 0; attempt < 2; attempt++) {
        const backend = launchBackend({ node: process.execPath, root, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
        try {
            const origin = await backend.ready;
            assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
            assert.equal((await fetch(origin + '/health')).status, 200);
            const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'desktop_admin', password: 'synthetic-fixture-password' }) });
            assert.equal(login.status, 200);
            const cookie = login.headers.get('set-cookie').split(';')[0];
            const request = (url, method = 'GET', body) => fetch(origin + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
            if (!attempt) {
                const created = await request('/api/chats', 'POST', { title: 'Desktop fixture' });
                assert.equal(created.status, 201);
                const chat = await created.json(); chatId = chat.id;
                const saved = await request(`/api/chats/${chatId}/messages`, 'POST', { role: 'user', content: 'Synthetic history', expectedRevision: chat.revision });
                assert.equal(saved.status, 201);
            }
            const history = await request(`/api/chats/${chatId}/messages`);
            assert.equal(history.status, 200);
            assert.equal((await history.json())[0].content, 'Synthetic history');
            const db = new (require('node:sqlite').DatabaseSync)(path.join(root, 'data', 'chatbot.db'), { readOnly: true });
            try { assert.equal(db.prepare('SELECT username FROM users').get().username, 'desktop_admin'); }
            finally { db.close(); }
        } finally { await backend.stop(); }
        assert.notEqual(backend.child.exitCode, null);
    }
});
