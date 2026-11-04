'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { initializeSchema } = require('../core/database-schema');
const {
    createSystemLogService, validateFilters, DEFAULT_MAX_AGE_MS, DEFAULT_MAX_EVENTS, MAX_PAGE_SIZE
} = require('../core/system-logs');
const { createSystemLogRoute } = require('../core/system-log-routes');
const auth = require('../auth');

function setup(t, options = {}) {
    const db = new DatabaseSync(':memory:');
    initializeSchema(db);
    t.after(() => db.close());
    let id = 0;
    const logs = createSystemLogService({
        db, createId: () => `event-${String(++id).padStart(6, '0')}`, ...options
    });
    t.after(() => logs.stop());
    return { db, logs };
}

function addUser(db, id, isAdmin = 1) {
    db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)')
        .run(id, id, 'unused', isAdmin);
    return auth.createSession(db, id);
}

test('schema migration is additive and idempotent', t => {
    const { db } = setup(t);
    initializeSchema(db);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_events'").get());
    assert.equal(db.prepare('PRAGMA table_info(system_events)').all().length, 11);
});

test('adding system events preserves existing database objects and user/session/chat data', t => {
    const { db } = setup(t);
    db.exec('DROP INDEX system_events_time; DROP INDEX system_events_severity_time; DROP INDEX system_events_category_time; DROP INDEX system_events_provider_time; DROP INDEX system_events_correlation; DROP TABLE system_events;');
    db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)')
        .run('preserved-user', 'preserved', 'hash-fixture', 1);
    const token = auth.createSession(db, 'preserved-user');
    db.prepare('INSERT INTO chats (id, title, scroll_top, user_id, revision) VALUES (?, ?, ?, ?, ?)')
        .run('preserved-chat', 'Preserved history', 17, 'preserved-user', 4);
    db.prepare('INSERT INTO messages (chat_id, role, content, telemetry_json, display_content) VALUES (?, ?, ?, ?, ?)')
        .run('preserved-chat', 'user', 'preserved message', '{"fixture":true}', 'preserved message');

    const schema = () => db.prepare(`
        SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'system_events%'
        ORDER BY type, name
    `).all();
    const records = () => Object.fromEntries(['users', 'sessions', 'chats', 'messages'].map(table =>
        [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const beforeSchema = schema();
    const beforeRecords = records();

    initializeSchema(db);

    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(records(), beforeRecords);
    assert.equal(auth.getSessionUser(db, token).id, 'preserved-user');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_events'").get());
});

test('default retention and pagination limits match the operational bounds', () => {
    assert.equal(DEFAULT_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
    assert.equal(DEFAULT_MAX_EVENTS, 50000);
    assert.equal(MAX_PAGE_SIZE, 100);
});

test('insertion persists fixed event text and allowlisted metadata only', async t => {
    const { db, logs } = setup(t);
    logs.log('AUTH_LOGIN_FAILED', {
        actorId: 'user-1',
        correlationId: 'corr-1',
        metadata: { reason: 'invalid_credentials', password: 'should-not-persist', token: 'secret' }
    });
    await logs.flush();
    const row = db.prepare('SELECT * FROM system_events').get();
    assert.equal(row.message, 'Sign-in failed');
    assert.equal(row.outcome, 'FAILURE');
    assert.equal(row.actor_id, 'user-1');
    assert.equal(row.correlation_id, 'corr-1');
    assert.equal(row.metadata_json, '{"reason":"invalid_credentials"}');
    assert.match(row.occurred_at, /^\d{4}-\d\d-\d\dT.*Z$/);
});

test('pagination, descending order, and structured filters return sanitized records', async t => {
    const { logs } = setup(t);
    logs.log('PROVIDER_CONNECTION_TEST_STARTED', {
        actorId: 'admin', providerId: 'deepseek-1', correlationId: 'trace-1',
        metadata: { diagnostic: true, prompt: 'private' }
    });
    logs.log('PROVIDER_CONNECTION_TEST_FAILED', {
        actorId: 'admin', providerId: 'openai-1',
        metadata: { reason: 'operation_failed', durationMs: 42, error: 'private' }
    });
    logs.log('AUTH_LOGOUT', { actorId: 'user-1' });
    await logs.flush();
    const first = logs.list({ page: 1, pageSize: 1 });
    assert.equal(first.total, 3);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].eventCode, 'AUTH_LOGOUT');
    assert.equal(first.events[0].metadata, null);
    const filtered = logs.list({ category: 'PROVIDER', providerId: 'deepseek-1', correlationId: 'trace-1' });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.events[0].metadata.diagnostic, true);
    assert.equal(JSON.stringify(filtered).includes('private'), false);
});

test('retention removes expired events and enforces the event count limit', async t => {
    let time = Date.UTC(2025, 0, 1);
    const { db, logs } = setup(t, { now: () => time, maxAgeMs: 1000, maxEvents: 3 });
    for (let i = 0; i < 5; i++) {
        logs.log('AUTH_LOGOUT', { actorId: `user-${i}` });
        time++;
    }
    await logs.flush();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM system_events').get().count, 3);
    time += 2000;
    logs.log('AUTH_LOGIN_SUCCEEDED', { actorId: 'user-new' });
    await logs.flush();
    const rows = db.prepare('SELECT actor_id FROM system_events').all();
    assert.deepEqual(rows.map(row => row.actor_id), ['user-new']);
});

test('filter and pagination validation rejects unsupported and unsafe values', () => {
    for (const filters of [
        { severity: 'TRACE' }, { category: 'DATABASE' }, { eventCode: 'bad code' },
        { providerId: 'bad/id' }, { correlationId: 'x'.repeat(129) },
        { from: 'not-a-date' }, { from: '2025-02-01', to: '2025-01-01' },
        { page: '0' }, { page: String(Number.MAX_SAFE_INTEGER) }, { pageSize: '101' }
    ]) assert.throws(() => validateFilters(filters));
});

test('administrator API filters, paginates, and revalidates the same session', async t => {
    const { db, logs } = setup(t);
    const token = addUser(db, 'admin', 1);
    logs.log('AUTH_LOGIN_SUCCEEDED', { actorId: 'admin' });
    await logs.flush();
    let revoked = false;
    const route = createSystemLogRoute({
        logs,
        validate: validateFilters,
        authenticate: req => auth.getSessionUser(db, auth.getSessionToken(req)),
        revalidate: req => {
            if (revoked) auth.deleteSession(db, auth.getSessionToken(req));
            return auth.getSessionUser(db, auth.getSessionToken(req));
        }
    });
    const request = (url, method = 'GET') => {
        let response;
        const res = {
            writeHead(status, headers) { response = { status, headers }; },
            end(body) { response.body = JSON.parse(body); }
        };
        const handled = route({ method, url, headers: { cookie: `chatbot_session=${token}` } }, res);
        return { handled, ...response };
    };
    const result = await request('/api/admin/system-logs?category=AUTH&pageSize=1');
    assert.equal(result.handled, true);
    assert.equal(result.status, 200);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.equal(result.body.total, 1);
    assert.equal(result.body.events[0].actorId, 'admin');
    assert.equal((await request('/api/admin/system-logs?pageSize=101')).status, 400);
    assert.equal((await request('/api/admin/system-logs?unknown=x')).status, 400);
    assert.equal((await request('/api/admin/system-logs', 'POST')).status, 405);
    revoked = true;
    assert.equal((await request('/api/admin/system-logs')).status, 401);
    const expiredToken = addUser(db, 'second-admin', 1);
    const expiredRoute = createSystemLogRoute({
        logs, validate: validateFilters,
        authenticate: req => auth.getSessionUser(db, auth.getSessionToken(req)),
        revalidate: req => {
            db.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').run('second-admin');
            return auth.getSessionUser(db, auth.getSessionToken(req));
        }
    });
    let expiredStatus;
    await expiredRoute({
        method: 'GET', url: '/api/admin/system-logs', headers: { cookie: `chatbot_session=${expiredToken}` }
    }, { writeHead(status) { expiredStatus = status; }, end() {} });
    assert.equal(expiredStatus, 401);
});

test('anonymous and non-admin access is denied and recorded without exposing data', async t => {
    const { db, logs } = setup(t);
    const token = addUser(db, 'user', 0);
    const route = createSystemLogRoute({
        logs, validate: validateFilters,
        authenticate: req => auth.getSessionUser(db, auth.getSessionToken(req)),
        revalidate: req => auth.getSessionUser(db, auth.getSessionToken(req))
    });
    async function request(cookie) {
        let status, body;
        await route({ method: 'GET', url: '/api/admin/system-logs', headers: cookie ? { cookie } : {} }, {
            writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); }
        });
        return { status, body };
    }
    assert.equal((await request()).status, 401);
    assert.equal((await request(`chatbot_session=${token}`)).status, 403);
    await logs.flush();
    const events = logs.list({ eventCode: 'AUTH_ADMIN_ACCESS_DENIED' }).events;
    assert.equal(events.length, 2);
    assert.ok(events.every(event => event.metadata.resource === 'system_logs'));
});

test('database read failures return sanitized server errors', async t => {
    const { db, logs } = setup(t);
    const token = addUser(db, 'admin', 1);
    const route = createSystemLogRoute({
        logs: { list() { throw new Error('sensitive database detail'); }, log: logs.log },
        validate: validateFilters,
        authenticate: req => auth.getSessionUser(db, auth.getSessionToken(req)),
        revalidate: req => auth.getSessionUser(db, auth.getSessionToken(req))
    });
    let status, body;
    await route({ method: 'GET', url: '/api/admin/system-logs', headers: { cookie: `chatbot_session=${token}` } }, {
        writeHead(code) { status = code; }, end(text) { body = text; }
    });
    assert.equal(status, 500);
    assert.equal(body, '{"error":"System logs unavailable"}');
});

test('bounded asynchronous queue isolates database failures and concurrent writes', async t => {
    const broken = createSystemLogService({ db: { prepare() { throw new Error('private database detail'); } } });
    broken.log('AUTH_LOGOUT', { actorId: 'u' });
    await assert.doesNotReject(() => broken.flush());
    assert.ok(broken.getStats().failures > 0);
    broken.stop();

    const { db, logs } = setup(t);
    await Promise.all(Array.from({ length: 250 }, (_, i) =>
        Promise.resolve().then(() => logs.log('AUTH_LOGOUT', { actorId: `user-${i}` }))));
    await logs.flush();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM system_events').get().count, 250);
});

test('queue capacity is bounded and overflow is counted rather than retained', async t => {
    let inserts = 0;
    const logs = createSystemLogService({
        db: { prepare(sql) { return { run() { if (sql.startsWith('INSERT')) inserts++; } }; } },
        setImmediateFn() {}
    });
    t.after(() => logs.stop());
    for (let i = 0; i < 1002; i++) logs.log('AUTH_LOGOUT', { actorId: 'user' });
    assert.deepEqual(logs.getStats(), { queued: 1000, dropped: 2, failures: 0 });
    await logs.flush();
    assert.equal(inserts, 1000);
    assert.equal(logs.getStats().queued, 0);
});

test('SQLite write contention drops only log events and later writes recover', async t => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chatbot-log-contention-'));
    const file=path.join(directory,'events.db');
    const primary=new DatabaseSync(file);
    initializeSchema(primary);
    const blocker=new DatabaseSync(file);
    const logs=createSystemLogService({db:primary});
    t.after(()=>{
        logs.stop();
        if(blocker.isTransaction)blocker.exec('ROLLBACK');
        blocker.close();primary.close();
        fs.rmSync(directory,{recursive:true,force:true});
    });

    blocker.exec('BEGIN EXCLUSIVE');
    logs.log('AUTH_LOGOUT',{actorId:'contended-user'});
    await logs.flush();
    assert.ok(logs.getStats().failures>0);
    blocker.exec('ROLLBACK');

    logs.log('AUTH_LOGOUT',{actorId:'recovered-user'});
    await logs.flush();
    assert.equal(primary.prepare('SELECT COUNT(*) AS count FROM system_events').get().count,1);
    assert.equal(primary.prepare('SELECT actor_id FROM system_events').get().actor_id,'recovered-user');
});
