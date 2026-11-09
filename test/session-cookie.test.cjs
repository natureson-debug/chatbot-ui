'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs');
function fresh() {
    const context = { module: { exports: {} }, process: { env: { CHATBOT_DESKTOP_CHILD: '1', CHATBOT_DESKTOP_LOOPBACK: '1' } } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../core/session-cookie'), 'utf8'), context);
    return context.module.exports;
}
test('ordinary server keeps exact Secure cookie despite inherited desktop environment', () => {
    for (const host of ['127.0.0.1', '0.0.0.0']) {
        const cookie = fresh().createSessionCookiePolicy(host);
        assert.equal(cookie('abc', '127.0.0.1'), 'chatbot_session=abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400');
        assert.equal(cookie('', '127.0.0.1'), 'chatbot_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    }
});
test('desktop requires explicit opt-in and exact loopback configuration and connection', () => {
    for (const host of ['0.0.0.0', '::1', 'localhost', undefined]) assert.throws(() => fresh().enableDesktopLoopback(host), /REJECTED/);
    const api = fresh(); api.enableDesktopLoopback('127.0.0.1');
    assert.throws(() => api.createSessionCookiePolicy('0.0.0.0'), /REJECTED/);
    const cookie = api.createSessionCookiePolicy('127.0.0.1');
    assert.equal(cookie('abc', '127.0.0.1'), 'chatbot_session=abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400');
    assert.throws(() => cookie('abc', '192.0.2.1'), /REJECTED/);
});
test('ordinary startup seals policy against later desktop activation', () => {
    const api = fresh(); api.createSessionCookiePolicy('127.0.0.1');
    assert.throws(() => api.enableDesktopLoopback('127.0.0.1'), /REJECTED/);
});
