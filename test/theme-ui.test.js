'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const admin = fs.readFileSync('public/admin.js', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8');

test('all supported chat themes are applied and the standard brand is consistent', () => {
    const start = app.indexOf('function applyTheme(theme) {');
    const end = app.indexOf('\n}', start) + 2;
    const context = { document: { body: { dataset: {} } } };
    vm.createContext(context);
    vm.runInContext(app.slice(start, end), context);

    for (const theme of ['dark', 'normal-dark', 'normal-light']) {
        context.applyTheme(theme);
        assert.equal(context.document.body.dataset.theme, theme);
    }
    context.applyTheme('light');
    assert.equal(context.document.body.dataset.theme, 'normal-light');

    assert.match(html, /<h1>CHATBOT<\/h1>/);
    assert.doesNotMatch(html, /ROBCO|TERMLINK|SECURE ACCESS TERMINAL|Initialize Access/);
    assert.match(html, /<option value="normal-light">Light<\/option>/);
    assert.match(html, /<option value="normal-dark">Dark<\/option>/);
    assert.match(html, /<option value="dark">Phosphor<\/option>/);
    assert.match(css, /body:not\(\.admin-page\)\[data-theme\^="normal-"\] #loginForm/);
});

test('skills, model selection, and preferences are hidden in the Settings drawer', () => {
    const drawerStart = html.indexOf('<div id="settingsPanel"');
    const drawerEnd = html.indexOf('</div>', html.indexOf('<section class="settings">', drawerStart));
    const drawer = html.slice(drawerStart, html.indexOf('<div id="activeChatHeader"', drawerStart));

    assert.notEqual(drawerStart, -1);
    assert.notEqual(drawerEnd, -1);
    assert.match(drawer, /hidden>/);
    for (const id of ['activeSkills', 'useTools', 'chatModelSelect', 'systemPrompt', 'theme']) {
        assert.match(drawer, new RegExp(`id="${id}"`));
    }
});

test('normal themes reach the Admin Console and the launch progress screen is removed', () => {
    assert.match(admin, /"normal-dark", "normal-light"/);
    assert.doesNotMatch(html, /bootScreen|bootLog/);
    assert.doesNotMatch(fs.readFileSync('public/admin.html', 'utf8'), /bootScreen|bootLog/);
    assert.doesNotMatch(fs.readFileSync('public/terminal.js', 'utf8'), /bootScreen|bootLog|advanceBoot/);
    assert.match(css, /body\.admin-page\[data-theme\^="normal-"\]/);
});

test('Admin Console applies each theme returned by user settings', async () => {
    const source = admin.slice(0, admin.indexOf('\nfunction closeAllUserMenus')) + '\nloadThemeSettings()';

    for (const theme of ['dark', 'light', 'normal-dark', 'normal-light']) {
        let currentTheme = theme;
        const windowListeners = {};
        const documentListeners = {};
        const context = {
            console: { error() {} },
            document: {
                body: { dataset: {} },
                visibilityState: 'visible',
                getElementById: () => null,
                addEventListener: (event, listener) => { documentListeners[event] = listener; }
            },
            window: {
                addEventListener: (event, listener) => { windowListeners[event] = listener; }
            },
            fetch: async (url, options) => {
                assert.equal(url, '/api/settings');
                assert.equal(options.credentials, 'same-origin');
                return { ok: true, json: async () => ({ theme: currentTheme }) };
            }
        };
        vm.createContext(context);
        await vm.runInContext(source, context);
        assert.equal(context.document.body.dataset.theme, theme === 'light' ? 'normal-light' : theme);

        currentTheme = theme === 'normal-light' ? 'normal-dark' : 'normal-light';
        await windowListeners.focus();
        assert.equal(context.document.body.dataset.theme, currentTheme);
        currentTheme = theme;
        await documentListeners.visibilitychange();
        assert.equal(context.document.body.dataset.theme, theme === 'light' ? 'normal-light' : theme);
    }
});

test('theme save posts the selected value and reports server failures visibly', async () => {
    const start = app.indexOf('async function saveUserSettings()');
    const end = app.indexOf('\nsystemPromptBox.addEventListener', start);
    const source = `let userSettingsSaveQueue = Promise.resolve();\n${app.slice(start, end)}\nsaveUserSettings()`;
    const status = { hidden: true, textContent: '' };
    const requests = [];
    const context = {
        systemPromptBox: { value: '' },
        themeSelect: { value: 'normal-light' },
        temperatureInput: { value: '0.7' },
        maxTokensInput: { value: '4096' },
        thinkingToggle: { checked: false },
        userSettingsStatus: status,
        console: { error() {} },
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: false, status: 400, json: async () => ({ error: 'Invalid settings' }) };
        }
    };
    vm.createContext(context);
    await vm.runInContext(source, context);

    assert.equal(requests[0].url, '/api/settings');
    assert.equal(JSON.parse(requests[0].options.body).theme, 'normal-light');
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /Invalid settings/);
});

test('normal themes style the composer and keep button shadows consistent', () => {
    assert.match(css, /body:not\(\.admin-page\)\[data-theme="dark"\] #prompt[\s\S]*?font-family: inherit/);
    assert.match(css, /body:not\(\.admin-page\)\[data-theme\^="normal-"\] #prompt \{\s*font: inherit/);
    assert.match(css, /body:not\(\.admin-page\)\[data-theme\^="normal-"\] \.prompt-wrap/);
    assert.match(css, /body:not\(\.admin-page\)\[data-theme\^="normal-"\] label\[for="attachment"\]/);
    assert.match(css, /body:not\(\.admin-page\)\[data-theme\^="normal-"\] #newChat,[\s\S]*?#adminConsoleButton,[\s\S]*?box-shadow: none/);
    assert.match(css, /body:not\(\.admin-page\)\[data-theme\^="normal-"\] #newChat,[\s\S]*?#adminConsoleButton \{[\s\S]*?background: var\(--normal-surface\)/);
});

test('semantic theme tokens isolate terminal styling and standardize admin controls', () => {
    assert.match(css, /:root\s*\{[\s\S]*?--theme-page:[\s\S]*?--theme-input:[\s\S]*?--theme-accent:[\s\S]*?--theme-error:[\s\S]*?--theme-code-bg:/);
    assert.match(css, /body\[data-theme="normal-light"\][\s\S]*?--theme-page: #f4f6f9/);
    assert.match(css, /body\[data-theme="dark"\][\s\S]*?--theme-page: #030704[\s\S]*?--theme-glow: rgba/);
    assert.match(css, /\.message\.assistant pre \.code-copy-button\s*\{[\s\S]*?background: var\(--theme-panel\)/);

    const sharedAdminStyles = css.slice(css.indexOf('/* Admin Console tabs */'));
    assert.doesNotMatch(sharedAdminStyles, /var\(--(?:phos|phos-soft|phos-dim|phos-faint|phos-glow|line|line-strong|panel-solid|amber|red)\)/);
    assert.match(sharedAdminStyles, /body\.admin-page \.terminal-select-trigger[\s\S]*?background: var\(--theme-input\)/);
    assert.match(sharedAdminStyles, /body\.admin-page \.toggle-control[\s\S]*?background: var\(--theme-panel\)/);
    assert.match(sharedAdminStyles, /body\.admin-page :is\(\.provider-form, \.provider-safeguards\)[\s\S]*?color: var\(--theme-text\)/);
    assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.provider-connections-layout\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.provider-editor\s*\{\s*padding: 8px/);

    const normalChatStyles = css.slice(css.indexOf('/* Compact, conventional themes for the main chat UI. */'));
    assert.doesNotMatch(normalChatStyles, /Share Tech Mono|VT323|rgba\(138, 255, 160/);
    assert.doesNotMatch(css, /body\[data-theme="normal-light"\],\s*body\.admin-page\[data-theme\^="normal-"\]\s*\{\s*--theme-page/);
});
