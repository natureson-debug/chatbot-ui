'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createDatabaseCleanup
} = require('../core/database-cleanup');

const qualified = Object.freeze({
    completed: true,
    safeForDatabaseClose: true,
    reason: 'http-closed-and-requests-idle'
});

test('qualified shutdown closes database exactly once', async () => {
    let closeCalls = 0;

    const cleanup = createDatabaseCleanup({
        db: {
            close() {
                closeCalls++;
            }
        }
    });

    assert.equal(cleanup.getState(), 'open');

    const result = await cleanup.cleanup(qualified);

    assert.deepEqual(result, {
        completed: true,
        reason: 'database-closed'
    });

    assert.equal(closeCalls, 1);
    assert.equal(cleanup.getState(), 'closed');
});

test('unqualified shutdown never closes database', async () => {
    let closeCalls = 0;

    const cleanup = createDatabaseCleanup({
        db: {
            close() {
                closeCalls++;
            }
        }
    });

    const result = await cleanup.cleanup({
        completed: false,
        safeForDatabaseClose: false
    });

    assert.deepEqual(result, {
        completed: false,
        reason: 'shutdown-not-qualified'
    });

    assert.equal(closeCalls, 0);
    assert.equal(cleanup.getState(), 'open');
});

test('both qualification fields are required', async () => {
    let closeCalls = 0;

    const cleanup = createDatabaseCleanup({
        db: {
            close() {
                closeCalls++;
            }
        }
    });

    const invalidResults = [
        null,
        undefined,
        {},
        { completed: true },
        { safeForDatabaseClose: true },
        {
            completed: false,
            safeForDatabaseClose: true
        },
        {
            completed: true,
            safeForDatabaseClose: false
        }
    ];

    for (const result of invalidResults) {
        const outcome = await cleanup.cleanup(result);

        assert.equal(outcome.completed, false);
        assert.equal(outcome.reason, 'shutdown-not-qualified');
    }

    assert.equal(closeCalls, 0);
    assert.equal(cleanup.getState(), 'open');
});

test('concurrent qualified calls share one operation', async () => {
    let closeCalls = 0;

    const cleanup = createDatabaseCleanup({
        db: {
            close() {
                closeCalls++;
            }
        }
    });

    const first = cleanup.cleanup(qualified);
    const second = cleanup.cleanup(qualified);

    assert.strictEqual(first, second);

    const result = await first;

    assert.equal(result.completed, true);
    assert.equal(closeCalls, 1);
});

test('repeated cleanup after success does not close again', async () => {
    let closeCalls = 0;

    const cleanup = createDatabaseCleanup({
        db: {
            close() {
                closeCalls++;
            }
        }
    });

    const first = await cleanup.cleanup(qualified);
    const second = await cleanup.cleanup(qualified);

    assert.strictEqual(first, second);
    assert.equal(closeCalls, 1);
    assert.equal(cleanup.getState(), 'closed');
});

test('database close failure remains incomplete without retry', async () => {
    let closeCalls = 0;

    const cleanup = createDatabaseCleanup({
        db: {
            close() {
                closeCalls++;

                const error = new Error('Synthetic SQLite failure');
                error.code = 'SQLITE_BUSY';

                throw error;
            }
        }
    });

    const first = await cleanup.cleanup(qualified);

    assert.deepEqual(first, {
        completed: false,
        reason: 'database-close-failed',
        code: 'SQLITE_BUSY'
    });

    assert.equal(cleanup.getState(), 'incomplete');

    const second = await cleanup.cleanup(qualified);

    assert.strictEqual(second, first);
    assert.equal(closeCalls, 1);
});

test('unqualified call cannot interrupt pending closure', async () => {
    let closeCalls = 0;

    const cleanup = createDatabaseCleanup({
        db: {
            close() {
                closeCalls++;
            }
        }
    });

    const pending = cleanup.cleanup(qualified);

    const rejected = await cleanup.cleanup({
        completed: false,
        safeForDatabaseClose: false
    });

    assert.equal(rejected.completed, false);
    assert.equal(rejected.reason, 'shutdown-not-qualified');

    const completed = await pending;

    assert.equal(completed.completed, true);
    assert.equal(closeCalls, 1);
});

test('invalid database dependency is rejected', () => {
    assert.throws(
        () => createDatabaseCleanup({ db: null }),
        TypeError
    );

    assert.throws(
        () => createDatabaseCleanup({ db: {} }),
        TypeError
    );
});
