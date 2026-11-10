'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createAdminBenchmark } = require('../public/admin-benchmark');

class Element {
    constructor(id = '') {
        this.id = id;
        this.value = '';
        this.textContent = '';
        this.disabled = false;
        this.hidden = false;
        this.children = [];
        this.listeners = new Map();
        this.max = 1;
        this.progressValue = 0;
    }
    addEventListener(name, callback) {
        const listeners = this.listeners.get(name) || [];
        listeners.push(callback);
        this.listeners.set(name, listeners);
    }
    async emit(name, event = {}) {
        let result;
        for (const listener of this.listeners.get(name) || []) result = await listener(event);
        return result;
    }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    closest(selector) { return selector === '.admin-tab' ? null : null; }
    set value(value) { this._value = value; }
    get value() { return this._value; }
    set valueProgress(value) { this.progressValue = value; }
    setAttribute() {}
}

function fixture(fetch) {
    const ids = [
        'tab-benchmark', 'benchmarkForm', 'benchmarkStatus', 'benchmarkResults',
        'benchmarkRunSelect', 'benchmarkProgress', 'benchmarkProgressLabel',
        'benchmarkStart', 'benchmarkCancel', 'benchmarkExportJson', 'benchmarkExportCsv',
        'benchmarkModel', 'benchmarkHardware', 'benchmarkSuccessCount', 'benchmarkLatency',
        'benchmarkThroughput', 'benchmarkTtft', 'benchmarkPromptSpeed', 'benchmarkName',
        'benchmarkTarget', 'benchmarkPromptTokens', 'benchmarkOutputTokens',
        'benchmarkRepetitions', 'benchmarkWarmups', 'benchmarkConcurrency',
        'benchmarkTemperature', 'benchmarkSeed', 'benchmarkTimeout'
    ];
    const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
    elements['tab-benchmark'].hidden = false;
    Object.assign(elements, {
        benchmarkName: Object.assign(elements.benchmarkName, { value: 'UI benchmark' }),
        benchmarkTarget: Object.assign(elements.benchmarkTarget, { value: 'local-llama' }),
        benchmarkPromptTokens: Object.assign(elements.benchmarkPromptTokens, { value: '64' }),
        benchmarkOutputTokens: Object.assign(elements.benchmarkOutputTokens, { value: '16' }),
        benchmarkRepetitions: Object.assign(elements.benchmarkRepetitions, { value: '2' }),
        benchmarkWarmups: Object.assign(elements.benchmarkWarmups, { value: '1' }),
        benchmarkConcurrency: Object.assign(elements.benchmarkConcurrency, { value: '1' }),
        benchmarkTemperature: Object.assign(elements.benchmarkTemperature, { value: '0.2' }),
        benchmarkSeed: Object.assign(elements.benchmarkSeed, { value: '' }),
        benchmarkTimeout: Object.assign(elements.benchmarkTimeout, { value: '30' })
    });
    const document = {
        hidden: false,
        getElementById: id => elements[id],
        createElement: tag => Object.assign(new Element(), { tagName: tag }),
        addEventListener() {}
    };
    const assigned = [];
    const app = createAdminBenchmark({
        document,
        fetch,
        setTimer: () => 1,
        clearTimer() {},
        windowObject: { location: { assign: url => assigned.push(url) } }
    });
    return { app, elements, assigned };
}

const run = {
    runId: '01234567-89ab-cdef-0123-456789abcdef',
    benchmarkId: '12345678-9abc-def0-1234-56789abcdef0',
    name: 'UI benchmark',
    target: 'local-llama',
    status: 'completed',
    totalRepetitions: 2,
    completedRepetitions: 2,
    model: 'local-model',
    hardware: null,
    summary: {
        successfulRepetitions: 2,
        failedRepetitions: 0,
        averageLatencyMs: 100,
        medianLatencyMs: 100,
        averageEndToEndOutputTokensPerSecond: 20,
        medianEndToEndOutputTokensPerSecond: 20,
        averageTimeToFirstTokenMs: 10,
        medianTimeToFirstTokenMs: 10,
        averagePromptTokensPerSecond: null
    },
    results: [{
        repetition: 1,
        phase: 'measurement',
        status: 'success',
        inputTokens: 64,
        outputTokens: 16,
        durationMs: 100,
        timeToFirstTokenMs: 10,
        endToEndOutputTokensPerSecond: 20,
        promptTokensPerSecond: null,
        errorCategory: null
    }],
    createdAt: new Date().toISOString()
};

test('benchmark UI submits bounded configuration, displays results, and offers exports', async () => {
    const calls = [];
    const { app, elements, assigned } = fixture(async (url, options = {}) => {
        calls.push({ url, options });
        if (url === '/api/admin/benchmarks?limit=50') {
            return { ok: true, json: async () => ({ runs: calls.some(call => call.url.endsWith('/start')) ? [run] : [] }) };
        }
        if (url === '/api/admin/benchmarks/start') return { ok: true, json: async () => ({ run }) };
        throw new Error('Unexpected request');
    });
    await app.initialize();
    assert.match(elements.benchmarkStatus.textContent, /Ready/);
    await elements.benchmarkForm.emit('submit', { preventDefault() {} });
    const start = calls.find(call => call.url.endsWith('/start'));
    const payload = JSON.parse(start.options.body);
    assert.equal(payload.target, 'local-llama');
    assert.equal(payload.promptTokenTarget, 64);
    assert.equal(payload.concurrency, 1);
    assert.equal(payload.seed, null);
    assert.equal(payload.timeoutMs, 30000);
    assert.equal(elements.benchmarkModel.textContent, 'local-model');
    assert.equal(elements.benchmarkSuccessCount.textContent, '2 / 0');
    assert.match(elements.benchmarkThroughput.textContent, /tokens\/s/);
    assert.equal(elements.benchmarkResults.children.length, 1);
    assert.equal(elements.benchmarkExportJson.disabled, false);
    await elements.benchmarkExportJson.emit('click');
    assert.match(assigned[0], /format=json/);
    await elements.benchmarkExportCsv.emit('click');
    assert.match(assigned[1], /format=csv/);
});

test('benchmark UI uses text-only rendering and theme semantic tokens', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../public/admin-benchmark.js'), 'utf8');
    assert.match(html, /data-tab="benchmark"/);
    assert.match(html, /id="tab-benchmark"/);
    assert.match(html, /admin-benchmark\.js/);
    assert.match(css, /body\.admin-page \.benchmark-panel/);
    assert.match(css, /var\(--theme-(?:panel|input|text|border|accent|muted)\)/);
    assert.match(script, /cell\.textContent/);
    assert.doesNotMatch(script, /\.innerHTML\s*=/);
});
