'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    createRequestTracker
} = require('../core/request-tracker');

const {
    createGracefulShutdown
} = require('../core/graceful-shutdown');

const {
    createShutdownCoordinator
} = require('../core/shutdown-coordinator');

const {
    createDatabaseCleanup
} = require('../core/database-cleanup');

const {
    createLifecycleOrchestrator
} = require('../core/lifecycle-orchestrator');

async function createHarness(handler, options = {}) {
    const tracker = createRequestTracker();

    const server = http.createServer(
        tracker.track(handler)
    );

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    let closeCalls = 0;

    const gracefulShutdown = createGracefulShutdown({
        server,
        gracePeriodMs: options.gracePeriodMs ?? 100,
        cleanupTimeoutMs: options.cleanupTimeoutMs ?? 100
    });

    const coordinator = createShutdownCoordinator({
        requestTracker: tracker,
        gracefulShutdown,
        timeoutMs: options.timeoutMs ?? 500
    });

    const databaseCleanup = createDatabaseCleanup({
        db: {
            close() {
                closeCalls++;
            }
        }
    });

    const orchestrator = createLifecycleOrchestrator({
        shutdownCoordinator: coordinator,
        databaseCleanup
    });

    return {
        server,
        tracker,
        orchestrator,
        getCloseCalls: () => closeCalls,
        port: server.address().port
    };
}

function makeRequest(port) {
    return new Promise((resolve, reject) => {
        http.get({
            hostname: '127.0.0.1',
            port,
            agent: false
        }, (res) => {
            res.resume();
            res.once('end', () => resolve(res.statusCode));
        }).once('error', reject);
    });
}

test('successful lifecycle closes HTTP before SQLite', async () => {
    const harness = await createHarness(
        async (_req, res) => {
            res.writeHead(200);
            res.end('OK');
        }
    );

    try {
        const status = await makeRequest(harness.port);

        assert.equal(status, 200);
        assert.equal(harness.tracker.getActiveCount(), 0);

        const first = harness.orchestrator.shutdown();
        const second = harness.orchestrator.shutdown();

        assert.strictEqual(first, second);

        const result = await first;

        assert.deepEqual(result, {
            completed: true,
            databaseClosed: true,
            reason: 'http-and-database-closed'
        });

        assert.equal(harness.getCloseCalls(), 1);
        assert.equal(harness.orchestrator.getState(), 'completed');
        assert.equal(harness.server.listening, false);
    } finally {
        harness.server.closeAllConnections();
        harness.server.close();
    }
});

test('disconnected unfinished handler prevents SQLite closure', async () => {
    let markStarted;
    const started = new Promise((resolve) => {
        markStarted = resolve;
    });

    let releaseHandler;
    const holdHandler = new Promise((resolve) => {
        releaseHandler = resolve;
    });

    const harness = await createHarness(
        async (_req, res) => {
            markStarted();

            res.writeHead(200);
            res.flushHeaders();

            await holdHandler;

            if (!res.destroyed) {
                res.end('done');
            }
        },
        {
            gracePeriodMs: 30,
            cleanupTimeoutMs: 30,
            timeoutMs: 100
        }
    );

    try {
        const request = http.get({
            hostname: '127.0.0.1',
            port: harness.port,
            agent: false
        });

        request.on('error', () => {});

        await started;

        assert.equal(harness.tracker.getActiveCount(), 1);

        request.destroy();

        const result = await harness.orchestrator.shutdown();

        assert.equal(result.completed, false);
        assert.equal(result.databaseClosed, false);
        assert.equal(result.reason, 'shutdown-not-qualified');
        assert.equal(harness.getCloseCalls(), 0);
        assert.equal(harness.orchestrator.getState(), 'incomplete');
    } finally {
        releaseHandler();
        harness.server.closeAllConnections();
        harness.server.close();
    }
});
