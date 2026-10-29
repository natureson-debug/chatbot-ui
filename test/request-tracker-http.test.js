'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    createRequestTracker
} = require('../core/request-tracker');

function deferred() {
    let resolve;

    const promise = new Promise((done) => {
        resolve = done;
    });

    return { promise, resolve };
}

test('disconnected HTTP client does not hide unfinished handler', async (t) => {
    const tracker = createRequestTracker();

    const handlerStarted = deferred();
    const releaseHandler = deferred();

    const server = http.createServer(
        tracker.track(async (_req, res) => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream'
            });

            res.write('data: started\n\n');

            handlerStarted.resolve();

            await releaseHandler.promise;
        })
    );

    t.after(() => {
        releaseHandler.resolve();
        server.closeAllConnections();
        server.close();
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const port = server.address().port;

    const clientConnected = deferred();

    const client = http.get({
        hostname: '127.0.0.1',
        port,
        agent: false
    }, (res) => {
        res.on('data', () => {
            clientConnected.resolve();
        });

        res.on('error', () => {});
    });

    client.on('error', () => {});

    await handlerStarted.promise;
    await clientConnected.promise;

    assert.equal(tracker.getActiveCount(), 1);

    client.destroy();

    // Wait until the server observes the disconnect.
    await new Promise((resolve) => {
        const check = () => {
            server.getConnections((_error, count) => {
                if (count === 0) {
                    resolve();
                } else {
                    setImmediate(check);
                }
            });
        };

        check();
    });

    assert.equal(tracker.getActiveCount(), 1);

    let idle = false;

    const waiting = tracker.whenIdle().then(() => {
        idle = true;
    });

    releaseHandler.resolve();

    await waiting;

    assert.equal(idle, true);
    assert.equal(tracker.getActiveCount(), 0);
});
