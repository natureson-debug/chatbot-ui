'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createShutdownCoordinator
} = require('../core/shutdown-coordinator');

function deferred() {
    let resolve;
    let reject;

    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });

    return { promise, resolve, reject };
}

function fixture({
    active = 0,
    httpResult = null,
    timeoutMs = 1000
} = {}) {
    const idle = deferred();
    const http = deferred();

    const events = [];
    let draining = false;
    let activeCount = active;
    let shutdownCalls = 0;

    if (active === 0) {
        idle.resolve();
    }

    if (httpResult) {
        http.resolve(httpResult);
    }

    const requestTracker = {
        beginDrain() {
            events.push('drain');
            draining = true;
        },

        whenIdle() {
            return idle.promise;
        },

        getActiveCount() {
            return activeCount;
        }
    };

    const gracefulShutdown = {
        shutdown() {
            events.push('http-close');
            shutdownCalls++;
            return http.promise;
        }
    };

    const coordinator = createShutdownCoordinator({
        requestTracker,
        gracefulShutdown,
        timeoutMs
    });

    return {
        coordinator,
        events,

        isDraining() {
            return draining;
        },

        getShutdownCalls() {
            return shutdownCalls;
        },

        finishRequests() {
            activeCount = 0;
            idle.resolve();
        },

        completeHttp(result = {
            completed: true,
            reason: 'server-closed'
        }) {
            http.resolve(result);
        },

        rejectHttp(error = new Error('HTTP failure')) {
            http.reject(error);
        }
    };
}

test('successful shutdown requires HTTP closure and idle requests', async () => {
    const s = fixture({ active: 1 });

    const operation = s.coordinator.shutdown();

    assert.deepEqual(s.events, [
        'drain',
        'http-close'
    ]);

    assert.equal(s.isDraining(), true);
    assert.equal(s.getShutdownCalls(), 1);

    s.completeHttp();

    await Promise.resolve();
    await Promise.resolve();

    let settled = false;
    operation.then(() => {
        settled = true;
    });

    await Promise.resolve();

    assert.equal(settled, false);

    s.finishRequests();

    const result = await operation;

    assert.deepEqual(result, {
        completed: true,
        safeForDatabaseClose: true,
        reason: 'http-closed-and-requests-idle'
    });
});

test('idle requests alone cannot authorize database closure', async () => {
    const s = fixture({ active: 0 });

    const operation = s.coordinator.shutdown();

    let settled = false;
    operation.then(() => {
        settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(settled, false);

    s.completeHttp();

    const result = await operation;

    assert.equal(result.completed, true);
    assert.equal(result.safeForDatabaseClose, true);
});

test('incomplete HTTP shutdown never authorizes database closure', async () => {
    const s = fixture({
        active: 0,
        httpResult: {
            completed: false,
            reason: 'cleanup-confirmation-expired'
        }
    });

    const result = await s.coordinator.shutdown();

    assert.deepEqual(result, {
        completed: false,
        safeForDatabaseClose: false,
        reason: 'http-shutdown-incomplete'
    });
});

test('HTTP shutdown rejection fails closed', async () => {
    const s = fixture({ active: 0 });

    const operation = s.coordinator.shutdown();

    s.rejectHttp();

    const result = await operation;

    assert.equal(result.completed, false);
    assert.equal(result.safeForDatabaseClose, false);
    assert.equal(result.reason, 'http-shutdown-rejected');
});

test('repeated shutdown calls share one operation', async () => {
    const s = fixture({ active: 0 });

    const first = s.coordinator.shutdown();
    const second = s.coordinator.shutdown();

    assert.strictEqual(first, second);
    assert.equal(s.getShutdownCalls(), 1);

    s.completeHttp();

    const result = await first;

    assert.equal(result.completed, true);
    assert.equal(result.safeForDatabaseClose, true);
});

test('deadline expiry cannot authorize database closure', async () => {
    const s = fixture({
        active: 1,
        timeoutMs: 20
    });

    const operation = s.coordinator.shutdown();

    s.completeHttp();

    const result = await operation;

    assert.deepEqual(result, {
        completed: false,
        safeForDatabaseClose: false,
        reason: 'shutdown-deadline-expired'
    });
});

test('late completion cannot reverse expired shutdown', async () => {
    const s = fixture({
        active: 1,
        timeoutMs: 20
    });

    const operation = s.coordinator.shutdown();

    const result = await operation;

    s.finishRequests();
    s.completeHttp();

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(result.completed, false);
    assert.equal(result.safeForDatabaseClose, false);

    const repeated = await s.coordinator.shutdown();

    assert.strictEqual(repeated, result);
});

test('invalid coordinator configuration is rejected', () => {
    assert.throws(
        () => createShutdownCoordinator({
            requestTracker: {},
            gracefulShutdown: {}
        }),
        TypeError
    );

    assert.throws(
        () => createShutdownCoordinator({
            requestTracker: {
                beginDrain() {},
                whenIdle() {},
                getActiveCount() {
                    return 0;
                }
            },
            gracefulShutdown: {
                shutdown() {
                    return Promise.resolve({
                        completed: true
                    });
                }
            },
            timeoutMs: 0
        }),
        RangeError
    );
});

test('real graceful controller incomplete result blocks database cleanup', async () => {
    const {
        createGracefulShutdown
    } = require('../core/graceful-shutdown');

    const {
        createRequestTracker
    } = require('../core/request-tracker');

    let closeCalls = 0;
    let cleanupCalls = 0;

    const server = {
        close(_callback) {
            closeCalls++;

            // Deliberately never confirms server closure.
        },

        closeAllConnections() {
            cleanupCalls++;
        }
    };

    const tracker = createRequestTracker();

    const graceful = createGracefulShutdown({
        server,
        gracePeriodMs: 10,
        cleanupTimeoutMs: 10
    });

    const coordinator = createShutdownCoordinator({
        requestTracker: tracker,
        gracefulShutdown: graceful,
        timeoutMs: 200
    });

    const result = await coordinator.shutdown();

    assert.deepEqual(result, {
        completed: false,
        safeForDatabaseClose: false,
        reason: 'http-shutdown-incomplete'
    });

    assert.equal(closeCalls, 1);
    assert.equal(cleanupCalls, 1);
    assert.equal(tracker.isDraining(), true);
    assert.equal(graceful.getState(), 'incomplete');

    // Repeated calls cannot reverse the failed decision.
    const repeated = await coordinator.shutdown();

    assert.strictEqual(repeated, result);
});

test('completion evidence failure resolves incomplete without unhandled rejection',async()=>{
    const c=createShutdownCoordinator({requestTracker:{beginDrain(){},whenIdle:async()=>{},getActiveCount(){throw Error('unverifiable')}},
        gracefulShutdown:{shutdown:async()=>({completed:true})},timeoutMs:100});
    assert.equal((await c.shutdown()).safeForDatabaseClose,false);
});
