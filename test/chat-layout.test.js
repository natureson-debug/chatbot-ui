'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('public/app.js', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8');

function createElement(tagName) {
    const listeners = {};
    const attributes = {};
    const children = [];
    const classes = new Set();
    return {
        tagName,
        children,
        listeners,
        attributes,
        classList: {
            add: value => classes.add(value),
            remove: value => classes.delete(value),
            contains: value => classes.has(value)
        },
        setAttribute: (name, value) => { attributes[name] = value; },
        appendChild: child => children.push(child),
        addEventListener: (name, listener) => { listeners[name] = listener; }
    };
}

test('code copy controls have an icon, visible feedback, and retain clipboard behavior', async () => {
    const code = { textContent: 'const answer = 42;' };
    const pre = {
        buttons: [],
        querySelector: selector => selector === 'code' ? code : null,
        appendChild(button) { this.buttons.push(button); }
    };
    const messages = [];
    const timers = [];
    const context = {
        pre,
        document: {
            createElement,
            createElementNS: () => createElement('svg')
        },
        navigator: {
            clipboard: {
                writeText: async text => messages.push(text)
            }
        },
        window: {
            setTimeout: callback => timers.push(callback)
        },
        console: { error() {} }
    };
    vm.createContext(context);
    const start = app.indexOf('function addCodeCopyButtons(messageElement) {');
    const end = app.indexOf('\nfunction restoreChat()', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(`${app.slice(start, end)}\naddCodeCopyButtons({ querySelectorAll: () => [pre] });`, context);

    const button = pre.buttons[0];
    assert.equal(button.type, 'button');
    assert.equal(button.attributes['aria-label'], 'Copy code');
    assert.equal(button.children.length, 2);
    assert.equal(button.children[0].tagName, 'svg');
    const label = button.children[1];
    assert.equal(label.textContent, 'Copy');

    await button.listeners.click({ stopPropagation() {} });
    assert.deepEqual(messages, ['const answer = 42;']);
    assert.equal(label.textContent, 'Copied');
    assert.equal(button.classList.contains('copied'), true);
    timers.shift()();
    assert.equal(label.textContent, 'Copy');
    assert.equal(button.attributes['aria-label'], 'Copy code');
});

test('code-copy controls and composer share theme-token styling and responsive layout', () => {
    assert.match(css, /\.message\.assistant pre\s*\{\s*position: relative;[\s\S]*?padding: 44px 12px 12px;[\s\S]*?background: var\(--theme-code-bg\)/);
    assert.match(css, /\.message\.assistant pre \.code-copy-button\s*\{[\s\S]*?position: absolute;[\s\S]*?top: 6px;[\s\S]*?right: 6px;[\s\S]*?width: 84px;[\s\S]*?background: var\(--theme-panel\)/);
    assert.match(css, /footer\s*\{[\s\S]*?display: flex;[\s\S]*?align-items: center;/);
    assert.match(css, /\.prompt-wrap\s*\{[\s\S]*?flex: 1 1 0;[\s\S]*?min-width: 0/);
    assert.match(css, /#prompt\s*\{[\s\S]*?min-width: 0;[\s\S]*?max-height: min\(30dvh, 220px\)/);
    assert.match(css, /footer > button\s*\{\s*flex: 0 0 auto;[\s\S]*?min-height: 46px/);
    assert.match(css, /@media \(max-width: 600px\)\s*\{[\s\S]*?footer\s*\{\s*flex-wrap: wrap[\s\S]*?footer \.prompt-wrap\s*\{\s*flex: 0 0 100%/);
    assert.doesNotMatch(css, /body:not\(\.admin-page\)\s+#send,\s*body:not\(\.admin-page\)\s+#stop\s*\{\s*width: 100%/);
});
