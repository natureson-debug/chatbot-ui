'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAdminLogs } = require('../public/admin-logs');

class Element {
    constructor(document) {
        this.document = document;
        this.children = [];
        this.handlers = {};
        this.attributes = {};
        this.dataset = {};
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.textContent = '';
        this.className = '';
        this.open = false;
    }

    append(...children) {
        for (const child of children) {
            child.parent = this;
            this.children.push(child);
        }
    }

    prepend(child) {
        child.parent = this;
        this.children.unshift(child);
    }

    replaceChildren(...children) {
        this.children = [];
        this.append(...children);
    }

    addEventListener(name, handler) {
        (this.handlers[name] ||= []).push(handler);
    }

    async dispatch(name, event = {}) {
        for (const handler of this.handlers[name] || []) await handler({
            target: this,
            preventDefault() {},
            ...event
        });
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    }

    focus() {
        this.document.activeElement = this;
    }

    showModal() {
        this.open = true;
    }

    close() {
        if (!this.open) return;
        this.open = false;
        void this.dispatch('close');
    }

    get lastElementChild() {
        return this.children.at(-1) || null;
    }

    set innerHTML(_value) {
        throw new Error('HTML rendering is not allowed');
    }
}

const IDS = [
    'tab-logs', 'systemLogsStatus', 'systemLogsRows', 'systemLogsCount', 'systemLogsLastRefresh',
    'systemLogsPage', 'systemLogsPageSize', 'systemLogsAutoRefresh', 'systemLogsRefresh',
    'systemLogsPrevious', 'systemLogsNext', 'systemLogsFilters', 'systemLogsNotifications',
    'systemLogsSeverity', 'systemLogsCategory', 'systemLogsEventCode', 'systemLogsProviderId',
    'systemLogsFrom', 'systemLogsTo', 'systemLogsCorrelationId', 'systemLogsClear',
    'systemLogDetailDialog', 'systemLogDetailTitle', 'systemLogDetailFields',
    'systemLogCopyStatus', 'systemLogCopy', 'systemLogClose'
];

function setup(fetch) {
    const nodes = Object.fromEntries(IDS.map(id => [id, new Element(null)]));
    const logsTab = new Element(null);
    logsTab.dataset.tab = 'logs';
    const otherTab = new Element(null);
    otherTab.dataset.tab = 'users';
    const timers = new Map();
    const document = {
        hidden: false,
        activeElement: null,
        handlers: {},
        getElementById: id => nodes[id],
        createElement: () => new Element(document),
        querySelectorAll: selector => selector === '.admin-tab' ? [logsTab, otherTab] : [],
        addEventListener(name, handler) {
            (this.handlers[name] ||= []).push(handler);
        }
    };
    for (const node of Object.values(nodes)) node.document = document;
    logsTab.document = document;
    otherTab.document = document;
    const windowObject = new Element(document);
    const clipboard = { written: '', async writeText(value) { this.written = value; } };
    let timerId = 0;
    const logs = createAdminLogs({
        document,
        fetch,
        clipboard,
        windowObject,
        setTimer(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        }
    });
    return {
        nodes,
        document,
        logsTab,
        otherTab,
        timers,
        clipboard,
        logs,
        async open() {
            nodes['tab-logs'].hidden = false;
            await logsTab.dispatch('click');
            await settle();
        },
        async runTimer() {
            const [id, timer] = timers.entries().next().value || [];
            if (!timer) return false;
            timers.delete(id);
            timer.callback();
            await settle();
            return true;
        }
    };
}

function response(data, status = 200) {
    return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

function event(eventId, values = {}) {
    return {
        eventId,
        timestamp: '2026-11-04T10:00:00.000Z',
        severity: 'INFO',
        category: 'AUTH',
        eventCode: 'AUTH_LOGIN_SUCCEEDED',
        message: 'User signed in',
        metadata: null,
        correlationId: null,
        actorId: 'user-id',
        providerId: null,
        outcome: 'SUCCESS',
        ...values
    };
}

function result(events, total = events.length) {
    return { events, page: 1, pageSize: 25, total };
}

async function settle() {
    await new Promise(resolve => setImmediate(resolve));
}

test('Logs section loads on activation and renders API strings as text', async () => {
    const payload = event('one', {
        eventCode: '<img src=x onerror=alert(1)>',
        message: '<script>not executable</script>'
    });
    const requests = [];
    const ui = setup(async url => {
        requests.push(url);
        return response(result([payload], 7));
    });

    assert.equal(requests.length, 0);
    await ui.open();

    assert.equal(requests.length, 1);
    assert.match(requests[0], /^\/api\/admin\/system-logs\?/);
    assert.equal(ui.nodes.systemLogsCount.textContent, '7 matching events');
    assert.equal(ui.nodes.systemLogsRows.children.length, 1);
    assert.equal(ui.nodes.systemLogsRows.children[0].children[3].children[0].textContent, payload.eventCode);
    assert.equal(ui.nodes.systemLogsRows.children[0].children[4].textContent, payload.message);
    assert.equal(ui.nodes.systemLogsPage.textContent, 'Page 1');
    ui.logs.dispose();
});

test('filters, inclusive date range, page size and navigation use supported API parameters', async () => {
    const requests = [];
    const ui = setup(async url => {
        requests.push(new URL(url, 'http://localhost'));
        return response(result([], 60));
    });
    await ui.open();

    ui.nodes.systemLogsSeverity.value = 'ERROR';
    ui.nodes.systemLogsCategory.value = 'PROVIDER';
    ui.nodes.systemLogsEventCode.value = 'PROVIDER_CONNECTION_TEST_FAILED';
    ui.nodes.systemLogsProviderId.value = 'deepseek';
    ui.nodes.systemLogsFrom.value = '2026-11-01';
    ui.nodes.systemLogsTo.value = '2026-11-04';
    ui.nodes.systemLogsCorrelationId.value = 'trace-1';
    await ui.nodes.systemLogsFilters.dispatch('submit');
    await settle();

    const query = requests.at(-1).searchParams;
    assert.equal(query.get('severity'), 'ERROR');
    assert.equal(query.get('category'), 'PROVIDER');
    assert.equal(query.get('eventCode'), 'PROVIDER_CONNECTION_TEST_FAILED');
    assert.equal(query.get('providerId'), 'deepseek');
    assert.equal(query.get('from'), '2026-11-01T00:00:00.000Z');
    assert.equal(query.get('to'), '2026-11-04T23:59:59.999Z');
    assert.equal(query.get('correlationId'), 'trace-1');
    assert.equal(query.get('page'), '1');

    ui.nodes.systemLogsPageSize.value = '50';
    await ui.nodes.systemLogsPageSize.dispatch('change');
    await settle();
    assert.equal(requests.at(-1).searchParams.get('pageSize'), '50');

    await ui.nodes.systemLogsNext.dispatch('click');
    await settle();
    assert(requests.some(request => request.searchParams.get('page') === '2'));
    assert.equal(ui.nodes.systemLogsPage.textContent, 'Page 2');
    assert.equal(ui.nodes.systemLogsPrevious.disabled, false);

    await ui.nodes.systemLogsClear.dispatch('click');
    await settle();
    assert.equal(requests.at(-1).searchParams.has('severity'), false);
    assert.equal(requests.at(-1).searchParams.get('page'), '1');
    ui.logs.dispose();
});

test('automatic polling is opt-in, notifications exclude the initial snapshot and deduplicate new warnings', async () => {
    let current = [event('historical', { severity: 'ERROR', eventCode: 'OLD_ERROR' })];
    const ui = setup(async () => response(result(current)));
    await ui.open();
    assert.equal(ui.nodes.systemLogsNotifications.children.length, 0);
    assert.equal(ui.timers.size, 0);

    ui.nodes.systemLogsAutoRefresh.value = '15';
    await ui.nodes.systemLogsAutoRefresh.dispatch('change');
    assert.equal([...ui.timers.values()][0].delay, 15000);

    current = [
        event('new-warning', {
            severity: 'WARN',
            eventCode: 'PROVIDER_CONNECTION_TEST_FAILED',
            category: 'PROVIDER',
            message: 'Provider connection test failed'
        }),
        event('new-error', {
            severity: 'ERROR',
            category: 'SYSTEM',
            eventCode: 'SYSTEM_DATABASE_FAILURE',
            message: 'System operation failed'
        }),
        ...current
    ];
    await ui.runTimer();
    assert.equal(ui.nodes.systemLogsNotifications.children.length, 2);
    await ui.runTimer();
    assert.equal(ui.nodes.systemLogsNotifications.children.length, 2);

    ui.nodes['tab-logs'].hidden = true;
    await ui.otherTab.dispatch('click');
    assert.equal(ui.timers.size, 0);
    ui.logs.dispose();
});

test('event details are text-only and clipboard omits unavailable fields', async () => {
    const payload = event('detail', {
        eventCode: 'CONFIG_ADMIN_SETTINGS_UPDATED',
        metadata: { changedFields: ['model', 'contextSize'] },
        message: '<b>plain text</b>'
    });
    const ui = setup(async () => response(result([payload])));
    await ui.open();

    const codeButton = ui.nodes.systemLogsRows.children[0].children[3].children[0];
    await codeButton.dispatch('click');
    assert.equal(ui.nodes.systemLogDetailDialog.open, true);
    assert(ui.nodes.systemLogDetailFields.children.some(field =>
        field.children[1].textContent.includes('"contextSize"')));
    assert(ui.nodes.systemLogDetailFields.children.some(field =>
        field.children[1].textContent === '<b>plain text</b>'));
    assert(ui.nodes.systemLogDetailFields.children.some(field =>
        field.children[0].textContent === 'providerId' && field.children[1].textContent === 'Unavailable'));

    await ui.nodes.systemLogCopy.onclick();
    const copied = JSON.parse(ui.clipboard.written);
    assert.equal(copied.eventCode, 'CONFIG_ADMIN_SETTINGS_UPDATED');
    assert.equal(copied.metadata.changedFields[0], 'model');
    assert.equal(Object.hasOwn(copied, 'providerId'), false);
    ui.logs.dispose();
});

test('expired administrator session clears log data and stops polling', async () => {
    let authorized = true;
    const ui = setup(async () => authorized
        ? response(result([event('one')]))
        : response({ error: 'not exposed' }, 401));
    await ui.open();
    ui.nodes.systemLogsAutoRefresh.value = '15';
    await ui.nodes.systemLogsAutoRefresh.dispatch('change');
    authorized = false;
    await ui.runTimer();

    assert.equal(ui.nodes.systemLogsRows.children.length, 0);
    assert.match(ui.nodes.systemLogsStatus.textContent, /session has expired/i);
    assert.equal(ui.timers.size, 0);
    ui.logs.dispose();
});

test('API failures show safe messages instead of server response bodies', async () => {
    let statusCode = 500;
    const ui = setup(async () => response({ error: 'secret database detail' }, statusCode));
    await ui.open();
    assert.match(ui.nodes.systemLogsStatus.textContent, /temporarily unavailable/i);
    assert.doesNotMatch(ui.nodes.systemLogsStatus.textContent, /secret database detail/);

    statusCode = 400;
    await ui.nodes.systemLogsRefresh.dispatch('click');
    await settle();
    assert.match(ui.nodes.systemLogsStatus.textContent, /filters are invalid/i);
    ui.logs.dispose();
});

test('Admin Logs navigation, panel, API path and theme-token styles are wired', () => {
    const root = path.join(__dirname, '..', 'public');
    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'admin-logs.js'), 'utf8');

    assert.match(html, /data-tab="logs"/);
    assert.match(html, /id="tab-logs"[^>]+data-admin-tabpanel/s);
    assert.match(html, /src="\/admin-logs\.js"/);
    for (const token of ['--theme-panel', '--theme-text', '--theme-border', '--theme-accent', '--theme-warning', '--theme-error']) {
        assert(css.includes(`var(${token})`), `Expected ${token} token usage`);
    }
    assert(js.includes('`/api/admin/system-logs?'));
    assert.doesNotMatch(js, /\.innerHTML\s*=/);
});
