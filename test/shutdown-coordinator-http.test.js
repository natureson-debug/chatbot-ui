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

function deferred() {
    let resolve;

    const promise = new Promise((yes) => {
        resolve = yes;
    });

    return { promise, resolve };
}

async function createFixture(handler, options = {}) {
    const tracker = createRequestTracker();

    const server = http.createServer(
        tracker.track(handler)
    );

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const graceful = createGracefulShutdown({
        server,
        gracePeriodMs: options.gracePeriodMs ?? 100,
        cleanupTimeoutMs: options.cleanupTimeoutMs ?? 100
    });

    const coordinator = createShutdownCoordinator({
        requestTracker: tracker,
        gracefulShutdown: graceful,
        timeoutMs: options.timeoutMs ?? 500
    });

    return {
        tracker,
        server,
        coordinator,
        port: server.address().port
    };
}

function get(port, path = '/') {
    return new Promise((resolve, reject) => {
        http.get({
            hostname: '127.0.0.1',
            port,
            path,
            agent: false
        }, (res) => {
            const chunks = [];

            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString()
                });
            });
        }).on('error', reject);
    });
}

test('completed HTTP request permits coordinated shutdown', async () => {
    const s = await createFixture(async (_req, res) => {
        res.writeHead(200);
        res.end('OK');
    });

    const response = await get(s.port);

    assert.equal(response.status, 200);
    assert.equal(response.body, 'OK');

    const result = await s.coordinator.shutdown();

    assert.deepEqual(result, {
        completed: true,
        safeForDatabaseClose: true,
        reason: 'http-closed-and-requests-idle'
    });

    assert.equal(s.tracker.getActiveCount(), 0);
    assert.equal(s.tracker.isDraining(), true);
    assert.equal(s.server.listening, false);
});

test('disconnected client cannot hide unfinished handler', async () => {
    const entered = deferred();
    const release = deferred();

    const s = await createFixture(async (_req, res) => {
        res.writeHead(200);
        res.write('started');

        entered.resolve();

        await release.promise;
    });

    const client = http.get({
        hostname: '127.0.0.1',
        port: s.port,
        agent: false
    });

    // Consume the response so the client sees the headers.
    client.on('response', res => {
        res.resume();
    });

    // A deliberate client abort may produce ECONNRESET.
    client.on('error', () => {});

    await entered.promise;

    client.destroy();

    const operation = s.coordinator.shutdown();

    assert.equal(s.tracker.isDraining(), true);

    // HTTP closure may finish before the handler does.
    const result = await operation;

    assert.equal(result.completed, false);
    assert.equal(result.safeForDatabaseClose, false);
    assert.equal(result.reason, 'shutdown-deadline-expired');

    assert.equal(s.tracker.getActiveCount(), 1);

    release.resolve();

    await s.tracker.whenIdle();

    assert.equal(s.tracker.getActiveCount(), 0);
});

test('active handler finishing permits coordinated shutdown', async () => {
    const entered = deferred();
    const release = deferred();

    const s = await createFixture(async (_req, res) => {
        entered.resolve();

        await release.promise;

        res.writeHead(200);
        res.end('finished');
    });

    const response = get(s.port);

    await entered.promise;

    const operation = s.coordinator.shutdown();

    release.resolve();

    const received = await response;
    const result = await operation;

    assert.equal(received.status, 200);
    assert.equal(received.body, 'finished');

    assert.equal(result.completed, true);
    assert.equal(result.safeForDatabaseClose, true);
    assert.equal(s.tracker.getActiveCount(), 0);
});
