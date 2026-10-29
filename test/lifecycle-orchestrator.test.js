'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createLifecycleOrchestrator
} = require('../core/lifecycle-orchestrator');

const {
    createDatabaseCleanup
} = require('../core/database-cleanup');

const qualified = Object.freeze({
    completed: true,
    safeForDatabaseClose: true,
    reason: 'http-closed-and-requests-idle'
});

function createHarness(shutdownResult) {
    if (arguments.length === 0) {
        shutdownResult = qualified;
    }

    let coordinatorCalls = 0;
    let databaseCloseCalls = 0;

    const shutdownCoordinator = {
        async shutdown() {
            coordinatorCalls++;
            return shutdownResult;
        }
    };

    const databaseCleanup = createDatabaseCleanup({
        db: {
            close() {
                databaseCloseCalls++;
            }
        }
    });

    const orchestrator = createLifecycleOrchestrator({
        shutdownCoordinator,
        databaseCleanup
    });

    return {
        orchestrator,
        getCoordinatorCalls: () => coordinatorCalls,
        getDatabaseCloseCalls: () => databaseCloseCalls
    };
}

test('successful shutdown closes HTTP before database', async () => {
    const order = [];

    const orchestrator = createLifecycleOrchestrator({
        shutdownCoordinator: {
            async shutdown() {
                order.push('http');
                return qualified;
            }
        },
        databaseCleanup: {
            async cleanup(result) {
                assert.strictEqual(result, qualified);
                order.push('database');
                return { completed: true };
            }
        }
    });

    const result = await orchestrator.shutdown();

    assert.deepEqual(order, ['http', 'database']);
    assert.deepEqual(result, {
        completed: true,
        databaseClosed: true,
        reason: 'http-and-database-closed'
    });
    assert.equal(orchestrator.getState(), 'completed');
});

test('failed HTTP shutdown never closes database', async () => {
    const harness = createHarness({
        completed: false,
        safeForDatabaseClose: false,
        reason: 'http-shutdown-incomplete'
    });

    const result = await harness.orchestrator.shutdown();

    assert.equal(result.completed, false);
    assert.equal(result.databaseClosed, false);
    assert.equal(result.reason, 'shutdown-not-qualified');
    assert.equal(harness.getDatabaseCloseCalls(), 0);
    assert.equal(harness.orchestrator.getState(), 'incomplete');
});

test('shutdown deadline expiration never closes database', async () => {
    const harness = createHarness({
        completed: false,
        safeForDatabaseClose: false,
        reason: 'shutdown-deadline-expired'
    });

    const result = await harness.orchestrator.shutdown();

    assert.equal(result.completed, false);
    assert.equal(result.databaseClosed, false);
    assert.equal(harness.getDatabaseCloseCalls(), 0);
});

test('both qualification flags must be true', async () => {
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

    for (const shutdownResult of invalidResults) {
        const harness = createHarness(shutdownResult);

        const result = await harness.orchestrator.shutdown();

        assert.equal(result.completed, false);
        assert.equal(result.databaseClosed, false);
        assert.equal(harness.getDatabaseCloseCalls(), 0);
    }
});

test('coordinator rejection never closes database', async () => {
    let closeCalls = 0;

    const orchestrator = createLifecycleOrchestrator({
        shutdownCoordinator: {
            async shutdown() {
                throw new Error('Synthetic coordinator failure');
            }
        },
        databaseCleanup: {
            async cleanup() {
                closeCalls++;
                return { completed: true };
            }
        }
    });

    const result = await orchestrator.shutdown();

    assert.equal(result.reason, 'shutdown-coordinator-failed');
    assert.equal(result.databaseClosed, false);
    assert.equal(closeCalls, 0);
});

test('database cleanup failure is reported', async () => {
    const orchestrator = createLifecycleOrchestrator({
        shutdownCoordinator: {
            async shutdown() {
                return qualified;
            }
        },
        databaseCleanup: {
            async cleanup() {
                return {
                    completed: false,
                    reason: 'database-close-failed'
                };
            }
        }
    });

    const result = await orchestrator.shutdown();

    assert.equal(result.completed, false);
    assert.equal(result.databaseClosed, false);
    assert.equal(result.reason, 'database-cleanup-incomplete');
    assert.equal(orchestrator.getState(), 'incomplete');
});

test('database cleanup rejection is reported', async () => {
    const orchestrator = createLifecycleOrchestrator({
        shutdownCoordinator: {
            async shutdown() {
                return qualified;
            }
        },
        databaseCleanup: {
            async cleanup() {
                throw new Error('Synthetic cleanup failure');
            }
        }
    });

    const result = await orchestrator.shutdown();

    assert.equal(result.completed, false);
    assert.equal(result.databaseClosed, false);
    assert.equal(result.reason, 'database-cleanup-failed');
});

test('concurrent shutdown calls share one operation', async () => {
    const harness = createHarness();

    const first = harness.orchestrator.shutdown();
    const second = harness.orchestrator.shutdown();

    assert.strictEqual(first, second);

    const result = await first;

    assert.equal(result.completed, true);
    assert.equal(harness.getCoordinatorCalls(), 1);
    assert.equal(harness.getDatabaseCloseCalls(), 1);
});

test('repeated shutdown after completion is idempotent', async () => {
    const harness = createHarness();

    const first = await harness.orchestrator.shutdown();
    const second = await harness.orchestrator.shutdown();

    assert.strictEqual(first, second);
    assert.equal(harness.getCoordinatorCalls(), 1);
    assert.equal(harness.getDatabaseCloseCalls(), 1);
});

test('invalid dependencies are rejected', () => {
    assert.throws(
        () => createLifecycleOrchestrator({
            shutdownCoordinator: null,
            databaseCleanup: {}
        }),
        TypeError
    );

    assert.throws(
        () => createLifecycleOrchestrator({
            shutdownCoordinator: { shutdown() {} },
            databaseCleanup: null
        }),
        TypeError
    );
});
