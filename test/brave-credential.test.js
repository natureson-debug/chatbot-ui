'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('../core/protected-credentials');
const { policy, validate } = require('../core/extensions');
const { handle } = require('../core/extension-routes');

function cipher() {
    const key = crypto.randomBytes(32);
    return async (operation, data, entropy) => {
        if (operation === 'protect') {
            const iv = crypto.randomBytes(12);
            const encryptor = crypto.createCipheriv('aes-256-gcm', key, iv);
            encryptor.setAAD(Buffer.from(entropy));
            const encrypted = Buffer.concat([encryptor.update(data), encryptor.final()]);
            return Buffer.concat([iv, encryptor.getAuthTag(), encrypted]);
        }
        const decryptor = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
        decryptor.setAAD(Buffer.from(entropy));
        decryptor.setAuthTag(data.subarray(12, 28));
        return Buffer.concat([decryptor.update(data.subarray(28)), decryptor.final()]);
    };
}

function request(url, method, body) {
    return {
        url,
        method,
        headers: {
            'x-chatbot-action': 'extensions',
            origin: 'http://127.0.0.1:3000',
            host: '127.0.0.1:3000'
        },
        async *[Symbol.asyncIterator]() {
            if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        }
    };
}

function response() {
    return {
        statusCode: null,
        body: '',
        writeHead(status) { this.statusCode = status; },
        end(body = '') { this.body += body; }
    };
}

test('protected search configuration accepts the dedicated reference and legacy environment references', () => {
    const base = { version: 1, revision: 0, skills: [], mcp: [] };
    assert.equal(validate({ ...base, search: { provider: 'brave', enabled: true, credentialRef: 'protected:brave-search' } }).search.credentialRef,
        'protected:brave-search');
    assert.equal(validate({ ...base, search: { provider: 'brave', enabled: true, credentialRef: 'env:CHATBOT_BRAVE_API_KEY' } }).search.credentialRef,
        'env:CHATBOT_BRAVE_API_KEY');
    assert.throws(() => validate({ ...base, search: { provider: 'brave', enabled: true, credentialRef: 'protected:other' } }));
});

test('protected Brave credential resolves server-side without an environment variable or live search', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-brave-search-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = createStore(root, cipher());
    await store.saveBrave('synthetic-search-key');
    const config = {
        search: { provider: 'brave', enabled: true, credentialRef: 'protected:brave-search' },
        skills: [],
        mcp: []
    };
    let requestOptions;
    const searchPolicy = policy(config, {
        readBrave: () => store.readBrave(),
        environment: {},
        fetchImpl: async (_url, options) => {
            requestOptions = options;
            return new Response(JSON.stringify({ web: { results: [
                { title: 'Synthetic result', url: 'https://example.test/', description: 'fixture' }
            ] } }));
        }
    });
    const tool = searchPolicy.definitions().find(item => item.function.name === 'internet_search');
    assert.ok(tool);
    const outcome = await searchPolicy.execute({
        user: 'test-admin',
        operationId: 'brave-search-test',
        name: 'internet_search',
        args: { query: 'harmless synthetic query' }
    });
    assert.equal(requestOptions.headers['X-Subscription-Token'], 'synthetic-search-key');
    assert.equal(outcome.result[0].title, 'Synthetic result');
});

test('admin credential API saves, reports status, and clears without returning the key', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-brave-admin-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = createStore(root, cipher());
    const user = { id: 'admin', is_admin: 1 };
    const dependencies = {
        user,
        revalidate: () => true,
        credentials: store,
        extensions: { async read() {
            return {
                version: 1, revision: 0, skills: [], mcp: [],
                search: { provider: 'brave', enabled: true, credentialRef: 'protected:brave-search' }
            };
        } }
    };

    let res = response();
    await handle(request('/api/admin/extensions/brave-credential', 'GET'), res, dependencies);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { configured: false });

    const sentinel = 'synthetic-never-return-this';
    res = response();
    await handle(request('/api/admin/extensions/brave-credential', 'POST', { action: 'save', credential: sentinel }), res, dependencies);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { configured: true });
    assert.equal(res.body.includes(sentinel), false);
    assert.equal(await store.readBrave(), sentinel);

    res = response();
    await handle(request('/api/admin/extensions/brave-credential', 'GET'), res, dependencies);
    assert.deepEqual(JSON.parse(res.body), { configured: true });
    assert.equal(res.body.includes(sentinel), false);

    res = response();
    await handle(request('/api/admin/extensions', 'GET'), res, dependencies);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).search.credentialRef, 'protected:brave-search');
    assert.equal(res.body.includes(sentinel), false);

    res = response();
    await handle(request('/api/admin/extensions/brave-credential', 'POST', { action: 'clear' }), res, dependencies);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { configured: false });
    assert.equal(await store.configuredBrave(), false);
    assert.equal(res.body.includes(sentinel), false);
});

test('admin credential API rejects unauthorized and stale-session writes', async () => {
    const base = {
        credentials: { async configuredBrave() { return false; }, async saveBrave() { throw Error('Must not save'); } },
        extensions: { async read() { return { version: 1, revision: 0, skills: [], mcp: [], search: null }; } }
    };
    let res = response();
    await handle(request('/api/admin/extensions/brave-credential', 'POST', { action: 'save', credential: 'sentinel' }),
        res, { ...base, user: { id: 'user', is_admin: 0 }, revalidate: () => true });
    assert.equal(res.statusCode, 403);
    res = response();
    await handle(request('/api/admin/extensions/brave-credential', 'POST', { action: 'save', credential: 'sentinel' }),
        res, { ...base, user: { id: 'admin', is_admin: 1 }, revalidate: () => false });
    assert.equal(res.statusCode, 401);
});
