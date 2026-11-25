'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { initializeSchema } = require('../core/database-schema');
const {
    createBenchmarkRunner,
    validateBenchmark,
    deterministicPrompt,
    exportCsv
} = require('../core/benchmark-runner');
const { createBenchmarkRoutes } = require('../core/benchmark-routes');

const configuration = overrides => ({
    name: 'Local test',
    target: 'local-llama',
    promptTokenTarget: 64,
    outputTokenLimit: 32,
    repetitions: 2,
    warmupRepetitions: 1,
    concurrency: 1,
    temperature: 0.2,
    seed: 7,
    timeoutMs: 5000,
    ...overrides
});

function setup(t, overrides = {}) {
    const db = new DatabaseSync(':memory:');
    initializeSchema(db);
    t.after(() => db.close());
    const runner = createBenchmarkRunner({
        db,
        createChatCompletion: async () => response(),
        readSlots: async () => [{ id: 0, is_processing: false }],
        getModel: async () => 'local-model',
        getHardware: async () => ({ gpus: [{ name: 'Test GPU', driver: 'test-driver' }] }),
        busyWaitMs: 10,
        busyPollMs: 1,
        ...overrides
    });
    return { db, runner };
}

function response({
    chunks = [
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":70,"completion_tokens":2},"timings":{"prompt_n":70,"prompt_ms":5}}\n\n',
        'data: [DONE]\n\n'
    ],
    status = 200
} = {}) {
    const body = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
        }
    });
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/event-stream' }
    });
}

async function waitForStatus(runner, runId, expected) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const run = runner.getRun(runId);
        if (run?.status === expected || ['failed', 'cancelled'].includes(run?.status) && expected !== 'cancelled') return run;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`Benchmark did not reach ${expected}`);
}

test('benchmark inputs are bounded and only local serial execution is permitted', () => {
    assert.deepEqual(validateBenchmark(configuration()), configuration());
    for (const invalid of [
        { target: 'https://example.test' }, { concurrency: 2 }, { repetitions: 21 },
        { warmupRepetitions: 6 }, { promptTokenTarget: 2049 }, { outputTokenLimit: 1025 },
        { timeoutMs: 999 }, { seed: -1 }, { extra: 'field' }, { name: 'x'.repeat(81) }
    ]) assert.throws(() => validateBenchmark(configuration(invalid)));
    assert.equal(deterministicPrompt(64), deterministicPrompt(64));
    assert.notEqual(deterministicPrompt(64), deterministicPrompt(128));
});

test('runner persists actual streamed measurements and never stores prompt or response text', async t => {
    const requests = [];
    const { db, runner } = setup(t, {
        createChatCompletion: async (body, options) => {
            requests.push({ body, signal: options.signal });
            return response();
        },
        clock: (() => { let time = 0; return () => (time += 10); })()
    });
    const started = await runner.start('admin-1', configuration());
    const run = await waitForStatus(runner, started.runId, 'completed');
    assert.equal(run.status, 'completed');
    assert.equal(run.totalRepetitions, 3);
    assert.equal(run.completedRepetitions, 3);
    assert.equal(run.summary.successfulRepetitions, 2);
    assert.equal(run.summary.warmupRepetitions, 1);
    assert.equal(run.results[0].phase, 'warmup');
    assert.equal(run.results[1].phase, 'measurement');
    assert.equal(run.results[1].inputTokens, 70);
    assert.equal(run.results[1].outputTokens, 2);
    assert.equal(run.results[1].timeToFirstTokenMs, 10);
    assert.equal(run.results[1].durationMs, 20);
    assert.equal(run.results[1].endToEndOutputTokensPerSecond, 100);
    assert.equal(run.results[1].promptTokensPerSecond, 14000);
    assert.equal(run.model, 'local-model');
    assert.equal(run.hardware.gpus[0].name, 'Test GPU');
    assert.equal(requests.length, 3);
    assert.equal(requests[0].body.seed, 7);
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.max_tokens, 32);
    const stored = JSON.stringify(db.prepare('SELECT * FROM llm_benchmarks').all()) +
        JSON.stringify(db.prepare('SELECT * FROM llm_benchmark_results').all());
    assert.doesNotMatch(stored, /Continue this deterministic|"content":"ok"|Bearer|api.?key/i);
    assert.match(exportCsv(run), /endToEndOutputTokensPerSecond/);
    assert.doesNotMatch(exportCsv(run), /Continue this deterministic|Bearer/i);
});

test('custom prompts cycle independently in warmups and measurements without being persisted', async t => {
    const prompts = ['PRIVATE custom prompt A', 'PRIVATE custom prompt B'];
    const seen = [];
    const { db, runner } = setup(t, {
        createChatCompletion: async body => { seen.push(body.messages[0].content); return response(); }
    });
    const started = await runner.start('admin', configuration({ prompts, repetitions: 3, warmupRepetitions: 1 }));
    const run = await waitForStatus(runner, started.runId, 'completed');
    assert.deepEqual(seen, [prompts[0], prompts[0], prompts[1], prompts[0]]);
    assert.equal(run.configuration.promptMode, 'custom');
    assert.equal(run.configuration.promptCount, 2);
    assert.doesNotMatch(JSON.stringify(run) + JSON.stringify(db.prepare('SELECT * FROM llm_benchmarks').all()) + exportCsv(run), /PRIVATE custom prompt/);
    assert.throws(() => validateBenchmark(configuration({ prompts, repetitions: 1 })));
    assert.throws(() => validateBenchmark(configuration({ prompts: [''] })));
    assert.throws(() => validateBenchmark(configuration({ prompts: ['a'.repeat(4097)] })));
});

test('YAML import validates schema, rejects aliases and requires an authorized admin', async () => {
    const admin = { id: 'admin', is_admin: 1 };
    let authorized = true;
    const route = createBenchmarkRoutes({
        runner: { start() {}, cancel() {}, listRuns() {}, getRun() {} },
        authenticate: req => req.admin,
        revalidate: req => authorized ? req.admin : null
    });
    async function request(body, user = admin) {
        let response;
        const req = { url: '/api/admin/benchmarks/import', method: 'POST', admin: user,
            async *[Symbol.asyncIterator]() { for (const chunk of Array.isArray(body) ? body : [body]) yield chunk; } };
        await route(req, { writeHead(status) { response = { status }; }, end(value) { response.body = value; } });
        return response;
    }
    const yaml = `name: Test
target: local-llama
promptTokenTarget: 64
outputTokenLimit: 32
repetitions: 2
warmupRepetitions: 1
concurrency: 1
temperature: 0.2
seed: null
timeoutMs: 5000
prompts:
  - First prompt
  - Second prompt
`;
    assert.equal((await request(yaml, null)).status, 401);
    assert.equal((await request(yaml, { id: 'user', is_admin: 0 })).status, 403);
    const valid = await request(yaml);
    assert.equal(valid.status, 200);
    assert.deepEqual(JSON.parse(valid.body).configuration.prompts, ['First prompt', 'Second prompt']);
    const unicode = Buffer.from(yaml.replace('First prompt', 'Test café'));
    const split = unicode.indexOf(Buffer.from('é')) + 1;
    const splitResult = await request([unicode.subarray(0, split), unicode.subarray(split)]);
    assert.equal(JSON.parse(splitResult.body).configuration.prompts[0], 'Test café');
    assert.equal((await request(yaml + 'unknown: 1\n')).status, 400);
    assert.equal((await request(yaml.replace('  - First prompt', '  - &p First prompt').replace('  - Second prompt', '  - *p'))).status, 400);
    assert.equal((await request('x'.repeat(65537))).status, 413);
    authorized = false;
    assert.equal((await request(yaml)).status, 401);
});

test('prompt processing speed is unavailable unless per-request timing evidence exists', async t => {
    const { runner } = setup(t, {
        createChatCompletion: async () => response({
            chunks: [
                'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
                'data: {"choices":[],"usage":{"prompt_tokens":68,"completion_tokens":1}}\n\n',
                'data: [DONE]\n\n'
            ]
        })
    });
    const started = await runner.start('admin', configuration({ repetitions: 1, warmupRepetitions: 0 }));
    const run = await waitForStatus(runner, started.runId, 'completed');
    assert.equal(run.results[0].promptTokensPerSecond, null);
    assert.equal(run.results[0].inputTokens, 68);
});

test('failed streams retain available latency and first-token measurements', async t => {
    const { runner } = setup(t, {
        createChatCompletion: async () => response({
            chunks: ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']
        }),
        clock: (() => { let time = 0; return () => (time += 5); })()
    });
    const started = await runner.start('admin', configuration({ repetitions: 1, warmupRepetitions: 0 }));
    const run = await waitForStatus(runner, started.runId, 'completed');
    assert.equal(run.results[0].status, 'failed');
    assert.equal(run.results[0].errorCategory, 'invalid_response');
    assert.equal(run.results[0].timeToFirstTokenMs, 5);
    assert.ok(run.results[0].durationMs >= 5);
    assert.equal(run.results[0].inputTokens, null);
});

test('runner refuses busy or unverifiable servers without issuing inference', async t => {
    let requests = 0;
    const busy = setup(t, {
        readSlots: async () => [{ id: 0, is_processing: true }],
        createChatCompletion: async () => { requests++; return response(); }
    });
    await assert.rejects(busy.runner.start('admin', configuration()), error => error.code === 'server_busy');
    assert.equal(requests, 0);
    assert.equal(busy.db.prepare('SELECT COUNT(*) AS count FROM llm_benchmark_runs').get().count, 0);

    const unknown = setup(t, {
        readSlots: async () => ({ status: 501, text: '' }),
        createChatCompletion: async () => { requests++; return response(); }
    });
    await assert.rejects(unknown.runner.start('admin', configuration()), error => error.code === 'busy_state_unavailable');
    assert.equal(requests, 0);
});

test('database uniqueness prevents concurrent runners from starting separate jobs', async t => {
    const db = new DatabaseSync(':memory:');
    initializeSchema(db);
    t.after(() => db.close());
    const gates = [];
    let preflights = 0;
    const makeRunner = () => createBenchmarkRunner({
        db,
        createChatCompletion: async () => response(),
        readSlots: async () => {
            if (preflights < 2) {
                preflights++;
                await new Promise(resolve => gates.push(resolve));
            }
            return [{ id: 0, is_processing: false }];
        },
        getModel: async () => 'local-model',
        busyWaitMs: 10,
        busyPollMs: 1
    });
    const firstRunner = makeRunner();
    const secondRunner = makeRunner();
    const starts = [
        firstRunner.start('admin-1', configuration({ repetitions: 1, warmupRepetitions: 0 })),
        secondRunner.start('admin-2', configuration({ repetitions: 1, warmupRepetitions: 0 }))
    ];
    while (gates.length < 2) await new Promise(resolve => setImmediate(resolve));
    gates.forEach(resolve => resolve());
    const outcomes = await Promise.allSettled(starts);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    const rejection = outcomes.find(item => item.status === 'rejected');
    assert.equal(rejection.reason.code, 'benchmark_active');
    const run = outcomes.find(item => item.status === 'fulfilled').value;
    await waitForStatus(firstRunner.getRun(run.runId) ? firstRunner : secondRunner, run.runId, 'completed');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM llm_benchmark_runs WHERE status IN ('queued','running')").get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM llm_benchmark_runs').get().count, 1);
});

test('only one active job is accepted and cancellation aborts the request, not the server', async t => {
    let requestStarted;
    const startedSignal = new Promise(resolve => { requestStarted = resolve; });
    const { runner } = setup(t, {
        createChatCompletion: (_body, { signal }) => new Promise((_resolve, reject) => {
            requestStarted();
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        })
    });
    const run = await runner.start('admin', configuration({ repetitions: 1, warmupRepetitions: 0 }));
    await startedSignal;
    await assert.rejects(runner.start('admin', configuration()), error => error.code === 'benchmark_active');
    assert.equal(runner.cancel(run.runId), true);
    const finished = await waitForStatus(runner, run.runId, 'cancelled');
    assert.equal(finished.status, 'cancelled');
    assert.equal(finished.results[0].errorCategory, 'cancelled');
    assert.equal(runner.activeRunId, null);
});

test('ordinary chat traffic preempts benchmarks and receives the inference slot first', async t => {
    let requestStarted;
    const startedSignal = new Promise(resolve => { requestStarted = resolve; });
    const { runner } = setup(t, {
        createChatCompletion: (_body, { signal }) => new Promise((_resolve, reject) => {
            requestStarted();
            signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })), { once: true });
        })
    });
    const run = await runner.start('admin', configuration({ repetitions: 1, warmupRepetitions: 0 }));
    await startedSignal;
    const releaseChat = await runner.beginChatRequest();
    assert.equal(runner.activeRunId, null);
    assert.equal((await waitForStatus(runner, run.runId, 'cancelled')).status, 'cancelled');
    await assert.rejects(runner.start('admin', configuration()), error => error.code === 'server_busy');
    releaseChat();
});

test('service restart marks interrupted jobs instead of resuming them', t => {
    const db = new DatabaseSync(':memory:');
    initializeSchema(db);
    t.after(() => db.close());
    const created = new Date().toISOString();
    db.prepare(`INSERT INTO llm_benchmarks VALUES ('b','admin','old','local-llama','{}',?)`).run(created);
    db.prepare(`INSERT INTO llm_benchmark_runs (run_id,benchmark_id,status,created_at,total_repetitions)
        VALUES ('r','b','running',?,1)`).run(created);
    createBenchmarkRunner({
        db,
        createChatCompletion: async () => response(),
        readSlots: async () => [{ id: 0, is_processing: false }],
        getModel: async () => 'local-model'
    });
    const row = db.prepare('SELECT status,error_category FROM llm_benchmark_runs WHERE run_id=?').get('r');
    assert.equal(row.status, 'failed');
    assert.equal(row.error_category, 'interrupted_by_restart');
});

test('benchmark schema migration is additive and CSV escapes spreadsheet formulas', async t => {
    const db = new DatabaseSync(':memory:');
    initializeSchema(db);
    t.after(() => db.close());
    db.prepare("INSERT INTO users (id,username,password_hash,is_admin) VALUES ('u','user','hash',1)").run();
    db.prepare("INSERT INTO chats (id,title,scroll_top,user_id) VALUES ('c','chat',0,'u')").run();
    db.prepare("INSERT INTO messages (chat_id,role,content) VALUES ('c','user','keep me')").run();
    const preserved = db.prepare(`SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM chats) AS chats,
        (SELECT COUNT(*) FROM messages) AS messages`).get();
    initializeSchema(db);
    assert.deepEqual({ ...db.prepare(`SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM chats) AS chats,
        (SELECT COUNT(*) FROM messages) AS messages`).get() }, { ...preserved });
    for (const table of ['llm_benchmarks', 'llm_benchmark_runs', 'llm_benchmark_results']) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='llm_benchmark_one_active'").get());
    const { runner } = setup(t, {});
    const started = await runner.start('admin', configuration({
        name: '=HYPERLINK("https://example.test")', repetitions: 1, warmupRepetitions: 0
    }));
    const run = await waitForStatus(runner, started.runId, 'completed');
    assert.match(exportCsv(run), /"'=HYPERLINK/);
});

test('benchmark routes require admin, revalidate sessions, and restrict exports to completed runs', async t => {
    const { runner } = setup(t, { busyWaitMs: 0 });
    const run = await runner.start('admin', configuration({ repetitions: 1, warmupRepetitions: 0 }));
    await waitForStatus(runner, run.runId, 'completed');
    let authorized = true;
    const route = createBenchmarkRoutes({
        runner,
        authenticate: req => req.admin,
        revalidate: req => authorized ? req.admin : null
    });
    async function request(url, method = 'GET', admin = null, body = '') {
        let responseValue;
        const req = {
            url, method, admin,
            async *[Symbol.asyncIterator]() { if (body) yield body; }
        };
        const res = {
            writeHead(status, headers) { responseValue = { status, headers }; },
            end(value) { responseValue.body = value; }
        };
        assert.equal(await route(req, res), true);
        return responseValue;
    }
    assert.equal((await request('/api/admin/benchmarks')).status, 401);
    assert.equal((await request('/api/admin/benchmarks', 'GET', { id: 'user', is_admin: 0 })).status, 403);
    const admin = { id: 'admin', is_admin: 1 };
    const list = await request('/api/admin/benchmarks', 'GET', admin);
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.body).runs[0].runId, run.runId);
    assert.equal((await request(`/api/admin/benchmarks/${run.runId}/export?format=csv`, 'GET', admin)).status, 200);
    assert.equal((await request(`/api/admin/benchmarks/${run.runId}/export?format=json`, 'GET', admin)).status, 200);
    authorized = false;
    assert.equal((await request(`/api/admin/benchmarks/${run.runId}`, 'GET', admin)).status, 401);
});
