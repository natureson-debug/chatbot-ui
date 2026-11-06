'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function providerFixture({ id = 'local-provider', failSave = false, notificationThrows = false } = {}) {
    const source = fs.readFileSync('public/admin-connections.js', 'utf8');
    const values = {
        providerId: id,
        providerName: 'Local',
        providerType: 'ollama',
        providerEndpoint: 'http://example.invalid',
        providerAuthMode: 'none',
        providerCredentialRef: '',
        providerModel: 'test-model',
        providerBackendIdentity: '',
        providerTimeoutMs: ''
    };
    const notices = [];
    const status = { textContent: '' };
    let saves = 0;
    const context = {
        document: { getElementById: key => ({ value: values[key] || '', checked: false }) },
        state: { connections: [] },
        editingId: null,
        presets: [],
        modelDraft: [{ id: 'test-model' }],
        structuredClone,
        status,
        closeForm() {},
        render() {},
        async save() {
            saves++;
            if (failSave) throw new Error('synthetic-secret-provider-response');
        },
        ChatbotNotifications: {
            show(notice) {
                if (notificationThrows) throw new Error('synthetic-secret-notification');
                notices.push(notice);
            }
        },
        console: { warn() {} }
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf(' function showResult('), source.indexOf(' async function api(')), context);
    vm.runInContext(source.slice(source.indexOf(' function collect()'), source.indexOf(' async function save(){')), context);
    return {
        notices, status, context,
        saves: () => saves,
        run: () => context.saveProvider({ preventDefault() {} })
    };
}

function aiFixture({ mismatch = false, failSave = false, notificationThrows = false } = {}) {
    const source = fs.readFileSync('public/admin.js', 'utf8');
    const notices = [];
    let click;
    let refreshes = 0;
    const context = {
        aiModel: { value: 'model.gguf' },
        aiParallel: { value: '1' },
        aiContextSize: { value: '32768' },
        aiGpuLayers: { value: '45' },
        aiDevice: { value: 'CUDA0' },
        aiVerbosity: { value: '4' },
        aiMetrics: { checked: false },
        aiConfigStatus: {},
        saveAiConfig: { addEventListener(_type, callback) { click = callback; } },
        async fetch(_url, options) {
            if (failSave) throw new Error('synthetic-secret-upstream');
            const config = JSON.parse(options.body);
            if (mismatch) delete config.device;
            return { ok: true, async json() { return { config }; } };
        },
        async loadAiServerStatus() { refreshes++; },
        ChatbotNotifications: {
            show(notice) {
                if (notificationThrows) throw new Error('synthetic-secret-notification');
                notices.push(notice);
            }
        },
        console: { error() {}, warn() {} }
    };
    vm.runInNewContext(source.slice(source.indexOf('saveAiConfig.addEventListener("click"')), context);
    return { notices, context, refreshes: () => refreshes, run: () => click() };
}

test('confirmed llama configuration save shows one restart warning without duplicate inline status', async () => {
    const ui = aiFixture();
    await ui.run();
    assert.equal(ui.notices.length, 1);
    assert.equal(ui.notices[0].severity, 'warning');
    assert.match(ui.notices[0].message, /Restart required.*Restart-ChatbotAI/);
    assert.equal(ui.context.aiConfigStatus.textContent, '');
    assert.equal(ui.context.aiConfigStatus.hidden, true);
    assert.equal(ui.refreshes(), 1);
});

test('unconfirmed and failed llama saves show one sanitized error, not a restart warning', async () => {
    for (const options of [{ mismatch: true }, { failSave: true }]) {
        const ui = aiFixture(options);
        await ui.run();
        assert.equal(ui.notices.length, 1);
        assert.equal(ui.notices[0].severity, 'error');
        assert.doesNotMatch(JSON.stringify(ui.notices), /synthetic-secret/);
        assert.equal(ui.refreshes(), 0);
    }
});

test('invalid provider ID shows its validation error without submitting or exposing field values', async () => {
    const ui = providerFixture({ id: 'synthetic-secret-invalid-id' });
    ui.context.document.getElementById = key => ({
        value: key === 'providerId' ? 'INVALID-synthetic-secret' : '',
        checked: false
    });
    await ui.run();
    assert.equal(ui.saves(), 0);
    assert.equal(ui.notices.length, 1);
    assert.equal(ui.notices[0].severity, 'error');
    assert.match(ui.notices[0].message, /Provider ID must start with a letter/);
    assert.equal(ui.status.textContent, '');
    assert.doesNotMatch(JSON.stringify(ui.notices), /synthetic-secret/);
});

test('valid provider save shows one success and failures do not expose server errors', async () => {
    const success = providerFixture();
    await success.run();
    assert.equal(success.saves(), 1);
    assert.equal(success.notices.length, 1);
    assert.equal(success.notices[0].severity, 'success');
    assert.equal(success.status.textContent, '');

    const failure = providerFixture({ failSave: true });
    await failure.run();
    assert.equal(failure.notices.length, 1);
    assert.equal(failure.notices[0].severity, 'error');
    assert.doesNotMatch(JSON.stringify(failure.notices), /synthetic-secret/);
    assert.equal(failure.context.state.connections.length, 0);
});

test('notification rendering failure does not turn a successful save into a failure', async () => {
    const provider = providerFixture({ notificationThrows: true });
    await provider.run();
    assert.equal(provider.status.textContent, 'Provider configuration saved.');
    const ai = aiFixture({ notificationThrows: true });
    await ai.run();
    assert.match(ai.context.aiConfigStatus.textContent, /Configuration saved/);
    assert.equal(ai.refreshes(), 1);
});
