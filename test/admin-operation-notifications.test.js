'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function providerFixture(api) {
    const source = fs.readFileSync('public/admin-connections.js', 'utf8');
    const notices = [];
    const nodes = {
        providerKeyStatus: {}, providerTestStatus: {}, providerApiKey: { value: 'synthetic-secret' },
        providerModel: { value: 'model' }, providerEnabled: {}
    };
    const context = {
        status: { textContent: '' }, discoverStatus: { textContent: '' },
        modelChoices: { children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } },
        document: { getElementById: id => nodes[id], createElement: () => ({}) },
        editingId: 'provider', api, load() {}, console: { warn() {} },
        window: { confirm: () => true },
        AdminProviderUI: { testResult: () => 'Connection details' },
        ChatbotNotifications: { show: notice => notices.push(notice) }
    };
    vm.createContext(context);
    for (const [start, end] of [
        [' function showResult(', ' async function api('],
        [' async function discover(', ' function updateType('],
        [' async function keyOperation(', " document.getElementById('saveProviderKey')"]
    ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
    return { context, notices, nodes };
}

test('discovery results retain model suggestions and issue exactly one sanitized popup', async () => {
    const ui = providerFixture(async () => ({ models: [{ id: 'example-model' }] }));
    await ui.context.discover('provider');
    assert.equal(ui.notices.length, 1);
    assert.equal(ui.notices[0].severity, 'success');
    assert.match(ui.context.discoverStatus.textContent, /example-model.*Capability classification/);
    assert.equal(ui.context.modelChoices.children[0].value, 'example-model');
    assert.equal(ui.context.status.textContent, '');
});

test('discovery and credential failures issue one safe popup without duplicate inline results', async () => {
    for (const action of ['discover', 'save']) {
        const ui = providerFixture(async () => { throw Error('synthetic-secret'); });
        if (action === 'discover') await ui.context.discover('provider');
        else await ui.context.keyOperation(action);
        assert.equal(ui.notices.length, 1);
        assert.equal(ui.notices[0].severity, 'error');
        assert.doesNotMatch(JSON.stringify(ui.notices), /synthetic-secret/);
        assert.equal(action === 'discover' ? ui.context.discoverStatus.textContent : ui.nodes.providerTestStatus.textContent, '');
    }
});

test('connection tests require an explicit success and preserve connection details', async () => {
    const ui = providerFixture(async () => ({ success: 'yes' }));
    await ui.context.keyOperation('test');
    assert.equal(ui.notices.length, 1);
    assert.equal(ui.notices[0].severity, 'error');
    assert.equal(ui.nodes.providerTestStatus.textContent, 'Connection details');
});

function extensionFixture() {
    const source = fs.readFileSync('public/admin-extensions.js', 'utf8');
    const ids = ['extensionConfig', 'extensionStatus', 'mcpCheckId', 'braveSearchCredential', 'braveCredentialStatus', 'clearBraveCredential', 'saveExtensions', 'reloadExtensions', 'checkMcp', 'saveBraveCredential'];
    const nodes = Object.fromEntries(ids.map(id => [id, {
        value: '', textContent: '', disabled: false,
        addEventListener(_type, callback) { this.click = callback; }
    }]));
    const notices = [];
    let fail = false;
    const context = {
        document: { getElementById: id => nodes[id] },
        ChatbotNotifications: { show: notice => notices.push(notice) },
        console: { warn() {} },
        async fetch(url) {
            if (fail) return { ok: false, json: async () => ({ error: 'synthetic-secret' }) };
            const data = url.endsWith('brave-credential') ? { configured: false } : url.endsWith('/check') ? { tools: [{ name: 'example-tool' }] } : { version: 1, skills: [] };
            return { ok: true, json: async () => data };
        }
    };
    vm.runInNewContext(source, context);
    return { nodes, notices, fail: () => { fail = true; } };
}

test('extension initialization stays quiet and explicit saves show one popup', async () => {
    const ui = extensionFixture();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.notices.length, 0);
    await ui.nodes.saveExtensions.click();
    assert.equal(ui.notices.length, 1);
    assert.equal(ui.notices[0].severity, 'success');
    assert.equal(ui.nodes.extensionStatus.textContent, '');
    ui.fail();
    await ui.nodes.saveExtensions.click();
    assert.equal(ui.notices.length, 2);
    assert.equal(ui.notices[1].severity, 'error');
    assert.equal(ui.nodes.extensionStatus.textContent, '');
    assert.doesNotMatch(JSON.stringify(ui.notices), /synthetic-secret/);
});

test('MCP tool list and Brave field validation remain inline', async () => {
    const ui = extensionFixture();
    await new Promise(resolve => setImmediate(resolve));
    ui.nodes.mcpCheckId.value = 'server';
    await ui.nodes.checkMcp.click();
    assert.match(ui.nodes.extensionStatus.textContent, /example-tool/);
    assert.equal(ui.notices.length, 1);
    await ui.nodes.saveBraveCredential.click();
    assert.match(ui.nodes.braveCredentialStatus.textContent, /Enter a key/);
    assert.equal(ui.notices.length, 1);
});

test('Brave credential failures are sanitized and retain credential status', async () => {
    const ui = extensionFixture();
    await new Promise(resolve => setImmediate(resolve));
    ui.nodes.braveSearchCredential.value = 'synthetic-secret';
    ui.fail();
    await ui.nodes.saveBraveCredential.click();
    assert.equal(ui.notices.length, 1);
    assert.equal(ui.notices[0].severity, 'error');
    assert.doesNotMatch(JSON.stringify(ui.notices), /synthetic-secret/);
    assert.equal(ui.nodes.braveCredentialStatus.textContent, 'Credential status unavailable.');
});

test('safeguard initial loads and refreshes are quiet while saves notify once', async () => {
    const source = fs.readFileSync('public/admin-openai.js', 'utf8');
    const notices = [];
    const fields = Object.fromEntries(['enabled', 'max_output_tokens', 'max_concurrent', 'per_hour', 'per_day', 'estimated_daily_usd'].map(name => [name, { value: '', checked: false }]));
    const form = { elements: { namedItem: name => fields[name] }, addEventListener(_type, callback) { this.submit = callback; } };
    const status = { textContent: '' }, summary = { textContent: '' };
    const refresh = { addEventListener(_type, callback) { this.click = callback; } };
    let fail = false;
    const context = {
        document: { getElementById(id) { return ({ openaiSafeguards: form, openaiUsageStatus: status, openaiUsageSummary: summary, refreshOpenaiUsage: refresh })[id] || null; } },
        ChatbotNotifications: { show: notice => notices.push(notice) },
        console: { warn() {} },
        fetch: async () => ({ ok: !fail, status: 500, json: async () => ({ settings: { enabled: false }, today: {}, environmentEnabled: false }) })
    };
    vm.runInNewContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    await refresh.click();
    assert.equal(notices.length, 0);
    form.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].severity, 'success');
    assert.equal(status.textContent, '');
    assert.match(summary.textContent, /Requests today/);
    fail = true;
    form.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notices.length, 2);
    assert.equal(notices[1].severity, 'error');
    assert.equal(status.textContent, '');
});

test('chat request failure shows one sanitized popup and retains the conversation notice', async () => {
    const source = fs.readFileSync('public/app.js', 'utf8');
    const marker = '} catch (error) {\n        if (!generationIsValid(generation)) return;\n        const cancelled';
    const start = source.indexOf(marker);
    assert.notEqual(start, -1);
    const end = source.indexOf('    } finally {', start);
    assert.notEqual(end, -1);
    const notices = [], assistantMessage = { notice: { textContent: '' } }, statusText = {};
    const error = Object.assign(new Error('synthetic-secret'), { responseStatus: 'failed' });
    const context = {
        error, generation: {}, generationIsValid: () => true, assistantMessage, statusText,
        isOriginVisible: () => true, responseStatus: '',
        ChatbotNotifications: { show: notice => notices.push(notice) }
    };
    await vm.runInNewContext('(async()=>{try{throw error;' + source.slice(start, end) + '}})()', context);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].severity, 'error');
    assert.doesNotMatch(JSON.stringify(notices), /synthetic-secret/);
    assert.match(assistantMessage.notice.textContent, /Response interrupted/);
    assert.equal(statusText.textContent, 'Error');
});
