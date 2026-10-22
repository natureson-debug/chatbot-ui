const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');

// Execute the actual module, but never open its production database or load auth.
function load(db) {
    const context = { module: { exports: {} }, __dirname: '/isolated', require(name) {
        if (name === 'node:sqlite') return { DatabaseSync: function () { return db; } };
        if (name === './auth') return { hashPassword() { throw Error('Unused in tests'); } };
        return require(name);
    } };
    vm.runInNewContext(source, context, { filename: 'db.js' });
    return context.module.exports;
}
function setup(t) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const api = load(db);
    db.exec("INSERT INTO users VALUES('u','user','unused',0)");
    api.createChat('a', 'Chat', 'u');
    return api;
}
const save = (api, revision, owner = 'u') => api.createMessage('a', 'assistant', 'text', { tokens: 2 }, owner, 'display', revision);

test('existing data migrates, repeated initialization preserves revision and messages', (t) => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    db.exec(`CREATE TABLE chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,scroll_top INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,telemetry_json TEXT);
        INSERT INTO chats(id,title) VALUES('old','Old'); INSERT INTO messages(chat_id,role,content) VALUES('old','user','old text');`);
    load(db);
    assert.equal(db.prepare('SELECT revision FROM chats').get().revision, 0);
    assert.equal(db.prepare('SELECT content FROM messages').get().content, 'old text');
    db.exec('UPDATE chats SET revision=7'); load(db);
    assert.equal(db.prepare('SELECT revision FROM chats').get().revision, 7);
});
test('migration failure aborts module loading and rolls back', (t) => {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    const exec = db.exec.bind(db);
    db.exec = (sql) => { if (sql.includes('ADD COLUMN revision')) throw Error('injected migration failure'); return exec(sql); };
    assert.throws(() => load(db), /injected migration failure/);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('PRAGMA table_info(chats)').all().some(c => c.name === 'revision'), false);
    db.exec = exec; load(db);
});
test('new chat defaults to zero; same-revision inserts preserve result and history', (t) => {
    const a = setup(t); assert.equal(a.getChatHistorySnapshot('a', 'u').revision, 0);
    assert.equal(save(a, 0), 1); assert.equal(save(a, 0), 2);
    assert.equal(JSON.stringify(a.getChatHistorySnapshot('a','u').messages), JSON.stringify(a.getMessages('a','u')));
});
test('missing and invalid revisions fail without insertion', (t) => {
    const a = setup(t);
    for (const r of [undefined, null, -1, 0.5, '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => save(a,r), /safe integer/);
    assert.equal(a.getMessages('a','u').length, 0);
});
test('clear increments, stale insertion conflicts, fresh insertion succeeds, empty clear increments', (t) => {
    const a = setup(t); save(a,0);
    assert.equal(JSON.stringify(a.clearChatMessages('a','u')), JSON.stringify({deletedMessages:1,revision:1}));
    assert.throws(() => save(a,0), e => e instanceof a.ChatRevisionConflictError && e.code === 'CHAT_REVISION_CONFLICT' && e.currentRevision === 1);
    save(a,1); a.clearChatMessages('a','u');
    assert.equal(a.clearChatMessages('a','u').revision, 3);
});
test('clear rollback restores deletion when revision update fails', (t) => {
    const a = setup(t); save(a,0);
    a.db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE OF revision ON chats BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => a.clearChatMessages('a','u'), /injected/);
    const s = a.getChatHistorySnapshot('a','u'); assert.equal(s.revision,0); assert.equal(s.messages.length,1);
});
test('outer transaction can enclose authorization and nested insertion; failure rolls back', (t) => {
    const a = setup(t);
    assert.throws(() => a.withWriteTransaction(() => { assert.equal(a.db.isTransaction,true); save(a,0); throw Error('authorization/test failure'); }), /authorization/);
    assert.equal(a.getMessages('a','u').length,0);
    assert.equal(a.withWriteTransaction(() => save(a,0)),1);
    assert.throws(() => a.withWriteTransaction(async () => {}), /synchronous/);
});
test('overflow does not remove messages; SQL rejects invalid revisions', (t) => {
    const a = setup(t); save(a,0); a.db.prepare('UPDATE chats SET revision=?').run(Number.MAX_SAFE_INTEGER);
    assert.throws(() => a.clearChatMessages('a','u'), /overflow/);
    assert.equal(a.getMessages('a','u').length,1);
    for (const r of [-1, 0.5, Number.MAX_SAFE_INTEGER+1]) assert.throws(() => a.db.prepare('UPDATE chats SET revision=?').run(r));
});
test('ownership, deleted chats and cascading foreign keys remain enforced', (t) => {
    const a = setup(t); save(a,0);
    assert.throws(() => save(a,0,'other'), /Chat not found/);
    assert.throws(() => a.clearChatMessages('a','other'), /Chat not found/);
    assert.throws(() => a.getChatHistorySnapshot('a','other'), /Chat not found/);
    a.deleteChat('a','u'); assert.throws(() => save(a,0), /Chat not found/);
    assert.equal(a.db.prepare('SELECT count(*) n FROM messages').get().n,0);
    assert.throws(() => a.db.exec("INSERT INTO messages(chat_id,role,content) VALUES('missing','user','x')"), /FOREIGN KEY/);
});
test('two connections serialize writers and preserve snapshot consistency', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-revision-test-'));
    const file = path.join(dir,'isolated.db'); const d1 = new DatabaseSync(file); const d2 = new DatabaseSync(file);
    try {
        const a = load(d1); const b = load(d2); d1.exec('PRAGMA journal_mode=WAL');
        d1.exec("INSERT INTO users VALUES('u','user','unused',0)"); a.createChat('a','Chat','u');
        a.withWriteTransaction(() => { save(a,0); assert.throws(() => b.clearChatMessages('a','u'), /locked/); });
        assert.equal(b.clearChatMessages('a','u').deletedMessages,1);
        assert.throws(() => save(a,0), e => e.code === 'CHAT_REVISION_CONFLICT'); save(a,1);
        d1.exec('BEGIN'); const before = a.getChatHistorySnapshot('a','u');
        b.clearChatMessages('a','u');
        assert.equal(JSON.stringify(a.getChatHistorySnapshot('a','u')),JSON.stringify(before));
        d1.exec('COMMIT'); const after = a.getChatHistorySnapshot('a','u');
        assert.equal(after.revision,2); assert.equal(after.messages.length,0);
    } finally { d2.close(); d1.close(); fs.rmSync(dir,{recursive:true}); }
});
