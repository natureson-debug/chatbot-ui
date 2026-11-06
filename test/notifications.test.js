'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createNotificationCenter } = require('../public/notifications');

class Element {
    constructor() {
        this.children = [];
        this.handlers = {};
        this.attributes = {};
        this.textContent = '';
        this.className = '';
        this.hidden = false;
        this.parent = null;
    }

    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) {
        for (const child of children) {
            child.parent = this;
            this.children.push(child);
        }
    }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
    dispatch(name, event = {}) {
        for (const callback of this.handlers[name] || []) callback({ target: this, ...event });
    }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    }
    contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
    querySelector(selector) {
        const matches = element => selector === `.${element.className}` || element.className.split(' ').includes(selector.slice(1));
        for (const child of this.children) {
            if (matches(child)) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }
}

function setup() {
    const body = new Element();
    const timers = new Map();
    let timerId = 0;
    let clock = 0;
    const document = { body, createElement: () => new Element() };
    const center = createNotificationCenter({
        document,
        now: () => clock,
        setTimer(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimer(id) { timers.delete(id); }
    });
    return {
        center, timers, body,
        el: () => body.children[0],
        advance(ms) { clock += ms; },
        fire(id) {
            const timer = timers.get(id);
            assert.ok(timer);
            timers.delete(id);
            timer.callback();
        }
    };
}

test('all severities render distinct roles and use approved durations', () => {
    const durations = [['success', 4000, 'status'], ['information', 5000, 'status'], ['warning', 10000, 'status'], ['error', 0, 'alert'], ['critical', 0, 'alert']];
    for (const [severity, duration, role] of durations) {
        const ui = setup();
        ui.center.show({ severity, title: 'Title', message: `${severity} message` });
        const toast = ui.el().children[0];
        assert.match(toast.className, new RegExp(`notification-toast--${severity}`));
        assert.equal(toast.attributes.role, role);
        assert.equal([...ui.timers.values()][0]?.delay || 0, duration);
        const close = toast.children[2].children.at(-1);
        close.dispatch('click');
        assert.equal(ui.center.getState().visible, 0);
    }
});

test('only three notifications are visible and queued notifications are not lost', () => {
    const ui = setup();
    const ids = ['one', 'two', 'three', 'four'].map(message =>
        ui.center.show({ severity: 'error', message })
    );
    assert.deepEqual(ui.center.getState(), { visible: 3, queued: 1 });
    assert.equal(ui.el().children.length, 3);
    assert.equal(ui.center.dismiss(ids[0]), true);
    assert.deepEqual(ui.center.getState(), { visible: 3, queued: 0 });
    assert.deepEqual(ui.el().children.map(item => item.children[1].children[1].textContent), ['two', 'three', 'four']);
});

test('critical notifications require acknowledgement and expose only whitelisted details', () => {
    const ui = setup();
    ui.center.show({
        severity: 'critical',
        message: 'A safe message',
        details: {
            eventCode: 'RUNTIME_BACKEND_HEALTH_CHANGED',
            category: 'RUNTIME',
            correlationId: 'req-1234',
            apiKey: 'secret-api-key',
            payload: 'sensitive-payload'
        }
    });
    const toast = ui.el().children[0];
    const actions = toast.children[2];
    assert.equal(actions.children[0].textContent, 'Acknowledge');
    assert.equal(ui.timers.size, 0);
    const detailsToggle = toast.children[1].children[2];
    detailsToggle.dispatch('click');
    const details = toast.children[1].children[3];
    assert.equal(details.hidden, false);
    const rendered = JSON.stringify(details.children.map(child => child.textContent));
    assert.match(rendered, /req-1234/);
    assert.doesNotMatch(rendered, /secret-api-key|sensitive-payload/);
    actions.children[0].dispatch('click');
    assert.equal(ui.center.getState().visible, 0);
});

test('timed notifications dismiss and promote the queued item', () => {
    const ui = setup();
    ui.center.show({ severity: 'success', message: 'saved' });
    ui.center.show({ severity: 'information', message: 'info' });
    ui.center.show({ severity: 'warning', message: 'warning' });
    ui.center.show({ severity: 'error', message: 'queued' });
    const [firstTimer] = ui.timers.keys();
    ui.fire(firstTimer);
    assert.deepEqual(ui.center.getState(), { visible: 3, queued: 0 });
    assert.deepEqual(ui.el().children.map(item => item.children[1].children[1].textContent), ['info', 'warning', 'queued']);
});

test('theme tokens and desktop/mobile positioning are defined without admin-specific styling', () => {
    const css = fs.readFileSync('public/notifications.css', 'utf8');
    for (const color of ['#67D79B', '#70B8FF', '#F0BA62', '#EF7777', '#E85E73',
        '#16704A', '#1D63B8', '#8F5400', '#B93131', '#9E1239',
        '#6EE79A', '#6FC8FF', '#F2C14E', '#FF8080', '#FF5C7A']) {
        assert.ok(css.includes(color), `missing approved severity color ${color}`);
    }
    assert.match(css, /right:\s*16px/);
    assert.match(css, /@media \(max-width:\s*600px\)/);
    assert.match(css, /left:\s*50%/);
    assert.match(css, /safe-area-inset-top/);
    for (const surface of ['#161E28', '#202938', '#FFFFFF', '#EAF0F7', '#101A12', '#19281C']) {
        assert.ok(css.includes(surface), `missing Penpot theme surface ${surface}`);
    }
    assert.match(css, /--theme-glow/);
});
