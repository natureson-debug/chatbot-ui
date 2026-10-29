'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

test('real HTTP server closes after an active response finishes', async (t) => {
    const requestStarted = deferred();
    const finishResponse = deferred();

    const server = http.createServer(async (_req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/plain'
        });

        res.write('started');
        requestStarted.resolve();

        await finishResponse.promise;

        res.end('finished');
    });

    t.after(() => {
        server.closeAllConnections();
        server.close();
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();

    const responsePromise = new Promise((resolve, reject) => {
        http.get({
            hostname: '127.0.0.1',
            port: address.port,
            agent: false
        }, (res) => {
            const chunks = [];

            res.on('data', (chunk) => chunks.push(chunk));

            res.on('end', () => {
                resolve(Buffer.concat(chunks).toString());
            });

            res.on('error', reject);
        }).on('error', reject);
    });

    await requestStarted.promise;

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 5000
    });

    const shutdownPromise = controller.shutdown();

    assert.equal(controller.getState(), 'stopping');

    finishResponse.resolve();

    const [body, result] = await Promise.all([
        responsePromise,
        shutdownPromise
    ]);

    assert.equal(body, 'startedfinished');
    assert.equal(result.completed, true);
    assert.equal(result.reason, 'server-closed');
    assert.equal(controller.getState(), 'stopped');
});

test('active response exceeding grace period closes after cleanup', async (t) => {
    const requestStarted = deferred();

    const server = http.createServer((_req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream'
        });

        res.write('data: waiting\n\n');
        requestStarted.resolve();

        // Intentionally leave the SSE response open.
    });

    t.after(() => {
        server.closeAllConnections();
        server.close();
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();

    const client = http.get({
        hostname: '127.0.0.1',
        port: address.port,
        agent: false
    }, (res) => {
        res.resume();
    });

    // Prevent expected connection teardown from becoming
    // an unhandled error.
    client.on('error', () => {});

    await requestStarted.promise;

    const controller = createGracefulShutdown({
        server,
        gracePeriodMs: 50
    });

    const result = await controller.shutdown();

    assert.deepEqual(result, {
        completed: true,
        reason: 'server-closed-after-cleanup'
    });

    assert.equal(controller.getState(), 'stopped');

    client.destroy();
});
