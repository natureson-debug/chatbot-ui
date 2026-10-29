'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createGracefulShutdown
} = require('../core/graceful-shutdown');

function deferred() {
    let resolve;

    const promise = new Promise((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

test('normal server closure completes successfully', async () => {
    let closeCalls = 0;

    const server = {
        close(callback) {
            closeCalls++;
            callback();
        }
    };

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 1000
    });

    assert.equal(controller.getState(), 'idle');

    const result = await controller.shutdown();

    assert.deepEqual(result, {
        completed: true,
        reason: 'server-closed'
    });

    assert.equal(controller.getState(), 'stopped');
    assert.equal(closeCalls, 1);
});

test('concurrent shutdown requests share one operation', async () => {
    const pending = deferred();

    let closeCalls = 0;
    let closeCallback;

    const server = {
        close(callback) {
            closeCalls++;
            closeCallback = callback;
        }
    };

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 1000
    });

    const first = controller.shutdown();
    const second = controller.shutdown();

    assert.strictEqual(first, second);
    assert.equal(closeCalls, 1);
    assert.equal(controller.getState(), 'stopping');

    closeCallback();
    pending.resolve();

    await pending.promise;

    const [a, b] = await Promise.all([first, second]);

    assert.strictEqual(a, b);
    assert.equal(a.completed, true);
    assert.equal(controller.getState(), 'stopped');
});

test('cleanup confirmation timeout reports incomplete shutdown', async () => {
    const callbacks = [];
    const delays = [];
    let cleanupCalls = 0;

    const server = {
        close() {
            // Server deliberately never confirms closure.
        },
        closeAllConnections() {
            cleanupCalls++;
        }
    };

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 15000,
        cleanupTimeoutMs: 2000,

        setTimer(callback, delay) {
            callbacks.push(callback);
            delays.push(delay);
            return callbacks.length;
        },

        clearTimer() {}
    });

    const pending = controller.shutdown();

    assert.equal(controller.getState(), 'stopping');

    callbacks[0]();

    assert.equal(controller.getState(), 'cleaning-up');
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(delays, [15000, 2000]);

    callbacks[1]();

    const result = await pending;

    assert.deepEqual(result, {
        completed: false,
        reason: 'cleanup-confirmation-expired'
    });

    assert.equal(controller.getState(), 'incomplete');
});

test('server close callback error reports incomplete shutdown', async () => {
    const server = {
        close(callback) {
            const error = new Error('Server is not running');
            error.code = 'ERR_SERVER_NOT_RUNNING';
            callback(error);
        }
    };

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 1000
    });

    const result = await controller.shutdown();

    assert.deepEqual(result, {
        completed: false,
        reason: 'server-close-error',
        code: 'ERR_SERVER_NOT_RUNNING'
    });

    assert.equal(controller.getState(), 'incomplete');
});

test('synchronous close exception reports incomplete shutdown', async () => {
    const server = {
        close() {
            throw new Error('Synthetic close failure');
        }
    };

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 1000
    });

    const result = await controller.shutdown();

    assert.equal(result.completed, false);
    assert.equal(result.reason, 'server-close-threw');
    assert.equal(controller.getState(), 'incomplete');
});

test('late close callback cannot reverse cleanup timeout', async () => {
    const callbacks = [];
    let closeCallback;

    const server = {
        close(callback) {
            closeCallback = callback;
        },
        closeAllConnections() {}
    };

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 15000,
        cleanupTimeoutMs: 2000,
        setTimer(callback) {
            callbacks.push(callback);
            return callbacks.length;
        },
        clearTimer() {}
    });

    const pending = controller.shutdown();

    callbacks[0]();
    callbacks[1]();

    const result = await pending;

    assert.equal(result.completed, false);
    assert.equal(
        result.reason,
        'cleanup-confirmation-expired'
    );

    closeCallback();

    assert.equal(controller.getState(), 'incomplete');
    assert.strictEqual(await controller.shutdown(), result);
});

test('invalid configuration is rejected', () => {
    assert.throws(
        () => createGracefulShutdown({}),
        TypeError
    );

    assert.throws(
        () => createGracefulShutdown({
            server: { close() {} },
            gracePeriodMs: 0
        }),
        RangeError
    );

    assert.throws(
        () => createGracefulShutdown({
            server: { close() {} },
            gracePeriodMs: -1
        }),
        RangeError
    );
});

test('deadline invokes cleanup once without premature success', async () => {
    const callbacks = [];
    let closeCalls = 0;
    let cleanupCalls = 0;

    const server = {
        close() {
            closeCalls++;
        },
        closeAllConnections() {
            cleanupCalls++;
        }
    };

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 15000,
        cleanupTimeoutMs: 2000,

        setTimer(callback) {
            callbacks.push(callback);
            return callbacks.length;
        },

        clearTimer() {}
    });

    const first = controller.shutdown();
    const second = controller.shutdown();

    assert.strictEqual(first, second);
    assert.equal(closeCalls, 1);

    callbacks[0]();

    assert.equal(cleanupCalls, 1);
    assert.equal(controller.getState(), 'cleaning-up');

    callbacks[1]();

    const result = await first;

    assert.deepEqual(result, {
        completed: false,
        reason: 'cleanup-confirmation-expired'
    });

    assert.equal(cleanupCalls, 1);
    assert.strictEqual(await controller.shutdown(), result);
});

test('confirmed closure after deadline is distinguished from unresolved cleanup', async () => {
    const callbacks = [];
    let closeCallback;
    let cleanupCalls = 0;

    const server = {
        close(callback) {
            closeCallback = callback;
        },

        closeAllConnections() {
            cleanupCalls++;

            // Simulate HTTP connections closing after cleanup.
            // The close callback is deliberately delayed.
        }
    };

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 15000,
        cleanupTimeoutMs: 2000,

        setTimer(callback) {
            callbacks.push(callback);
            return callbacks.length;
        },

        clearTimer() {}
    });
    const pending = controller.shutdown();
    callbacks[0]();

    // Cleanup was initiated, but server closure
    // has not yet been confirmed.
    assert.notEqual(controller.getState(), 'stopped');
    assert.equal(cleanupCalls, 1);

    // Simulate Node confirming the HTTP server has closed.
    closeCallback();

    const result = await pending;

    assert.deepEqual(result, {
        completed: true,
        reason: 'server-closed-after-cleanup'
    });

    assert.equal(controller.getState(), 'stopped');
});
