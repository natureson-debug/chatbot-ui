const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { blockedActivation } = require('../core/ai-activation');
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const start = source.indexOf('if (req.method === "POST" && req.url === "/api/admin/ai/restart")');
const end = source.indexOf('// Administrator-only AI configuration', start);
async function route(user) {
    let status, body;
    const run = vm.runInNewContext('(async () => {' + source.slice(start, end) + '})', {
        req: { method: 'POST', url: '/api/admin/ai/restart', headers: {host:'localhost:3000',origin:'http://localhost:3000','x-chatbot-action':'restart-ai'} },
        res: { writeHead(s) { status = s; }, end(s) { body = JSON.parse(s); } },
        getAuthenticatedUser: () => user, blockedActivation, console: {info(){}}, require: n => { if(n === "./core/restart-request") return require("../core/restart-request"); throw Error("Unexpected dependency"); }
    });
    await run(); return { status, body };
}
test('authentication and administrator checks preserved', async () => {
    assert.equal((await route(null)).status, 401);
    assert.equal((await route({ is_admin: 0 })).status, 403);
});
test('unqualified activation rejects concurrent requests without process providers', async () => {
    const results = await Promise.all([route({ is_admin: 1 }), route({ is_admin: 1 })]);
    for (const r of results) {
        assert.equal(r.status, 503);
        assert.equal(r.body.code, 'LIFECYCLE_ACTIVATION_DISABLED');
        assert.equal(r.body.ownership, 'unverified');
        assert.equal(r.body.state, 'blocked');
    }
});
function client(fetch) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../core/llama-client'), 'utf8'), {
        module, URL, AbortSignal, fetch,
        require(name) {
            if (name === 'fs') return { readFileSync: () => 'synthetic-test-key' };
            if (name === './config') return { LLAMA_URL: 'http://127.0.0.1:8080/v1/chat/completions', LLAMA_HEALTH_URL: 'http://127.0.0.1:8080/health', API_KEY_FILE: 'mock' };
            throw Error('Unexpected dependency');
        }
    });
    return module.exports;
}
test('reported model is actual API identity; authenticated bounded observation', async () => {
    const c = client(async (url, options) => {
        assert.equal(String(url), 'http://127.0.0.1:8080/v1/models');
        assert.ok(options.signal);
        assert.equal(options.headers.Authorization, 'Bearer synthetic-test-key');
        return { ok: true, json: async () => ({ data: [{ id: 'actual.gguf' }] }) };
    });
    assert.equal(await c.getReportedModel(), 'actual.gguf');
});
test('ambiguous or absent models remain unknown', async () => {
    for (const data of [[], [{ id: 'a' }, { id: 'b' }], [{}]]) {
        assert.equal(await client(async () => ({ ok: true, json: async () => ({ data }) })).getReportedModel(), null);
    }
});
test('unavailable and timed out observations cannot report activation success', async () => {
    await assert.rejects(client(async () => ({ ok: false })).getReportedModel());
    await assert.rejects(client(async () => { throw Error('timeout'); }).getReportedModel());
});
test('frontend removes changed-PID acceptance and uses text-only model display', () => {
    const ui = fs.readFileSync(require.resolve('../public/admin.js'), 'utf8');
    assert.ok(!ui.includes('waitForAiServer'));
    assert.ok(!ui.includes('aiActivationState'));
    assert.ok(!ui.includes('/api/admin/ai/restart'));
    assert.ok(ui.includes('\"Unavailable\"')); 
    assert.ok(ui.includes('aiModelState").textContent'));
    assert.ok(ui.includes('Configuration saved. Changes apply the next time the backend starts.'));
});
test('chat completion forwards AbortSignal and preserves legacy calls', async () => {
    const calls = [];

    const c = client(async (url, options) => {
        calls.push({ url: String(url), options });
        return { ok: true };
    });

    const controller = new AbortController();

    await c.createChatCompletion(
        { messages: [{ role: 'user', content: 'test' }] },
        { signal: controller.signal }
    );

    assert.equal(calls.length, 1);
    assert.equal(
        calls[0].url,
        'http://127.0.0.1:8080/v1/chat/completions'
    );
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(
        calls[0].options.headers.Authorization,
        'Bearer synthetic-test-key'
    );

    await c.createChatCompletion({ messages: [] });

    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.signal, undefined);
});
