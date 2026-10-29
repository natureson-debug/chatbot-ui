'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
    createRequestTracker
} = require('../core/request-tracker');

function deferred() {
    let resolve;
    let reject;

    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });

    return { promise, resolve, reject };
}

function response() {
    const res = new EventEmitter();

    res.headersSent = false;
    res.destroyed = false;
    res.writableFinished = false;
    res.statusCode = null;
    res.body = '';

    res.writeHead = function (status) {
        this.statusCode = status;
        this.headersSent = true;
        return this;
    };

    res.end = function (body = '') {
        this.body += body;
        this.writableFinished = true;
        this.emit('finish');
        return this;
    };

    res.disconnect = function () {
        this.destroyed = true;
        this.emit('close');
    };

    return res;
}

test('completed handler and response release tracking', async () => {
    const tracker = createRequestTracker();

    const handler = tracker.track((_req, res) => {
        res.end('ok');
    });

    const res = response();

    await handler({}, res);
    await tracker.whenIdle();

    assert.equal(tracker.getActiveCount(), 0);
    assert.equal(res.body, 'ok');
    assert.equal(res.listenerCount('finish'), 0);
    assert.equal(res.listenerCount('close'), 0);
});

test('handler completion alone does not release request', async () => {
    const tracker = createRequestTracker();

    const handler = tracker.track(() => {
        // Handler returns before response completes.
    });

    const res = response();

    await handler({}, res);

    assert.equal(tracker.getActiveCount(), 1);

    res.end();

    await tracker.whenIdle();

    assert.equal(tracker.getActiveCount(), 0);
});

test('client disconnect does not release unfinished handler', async () => {
    const tracker = createRequestTracker();
    const pending = deferred();

    const handler = tracker.track(async () => {
        await pending.promise;
    });

    const res = response();
    const running = handler({}, res);

    res.disconnect();

    assert.equal(tracker.getActiveCount(), 1);

    pending.resolve();

    await running;
    await tracker.whenIdle();

    assert.equal(tracker.getActiveCount(), 0);
});

test('handler rejection still requires response completion', async () => {
    const tracker = createRequestTracker();

    const handler = tracker.track(async () => {
        throw new Error('synthetic failure');
    });

    const res = response();

    await assert.rejects(
        handler({}, res),
        /synthetic failure/
    );

    assert.equal(tracker.getActiveCount(), 1);

    res.end();

    await tracker.whenIdle();

    assert.equal(tracker.getActiveCount(), 0);
});

test('whenIdle waits for all tracked requests', async () => {
    const tracker = createRequestTracker();

    const first = deferred();
    const second = deferred();

    const handler1 = tracker.track(async (_req, res) => {
        await first.promise;
        res.end();
    });

    const handler2 = tracker.track(async (_req, res) => {
        await second.promise;
        res.end();
    });

    const running1 = handler1({}, response());
    const running2 = handler2({}, response());

    assert.equal(tracker.getActiveCount(), 2);

    let idle = false;

    const waiting = tracker.whenIdle().then(() => {
        idle = true;
    });

    first.resolve();
    await running1;

    assert.equal(tracker.getActiveCount(), 1);
    assert.equal(idle, false);

    second.resolve();

    await Promise.all([running2, waiting]);

    assert.equal(idle, true);
    assert.equal(tracker.getActiveCount(), 0);
});

test('draining rejects new requests with HTTP 503', async () => {
    const tracker = createRequestTracker();

    let invoked = false;

    const handler = tracker.track(() => {
        invoked = true;
    });

    tracker.beginDrain();

    const res = response();

    await handler({}, res);

    assert.equal(invoked, false);
    assert.equal(res.statusCode, 503);
    assert.equal(res.writableFinished, true);
    assert.equal(tracker.getActiveCount(), 0);
    assert.equal(tracker.isDraining(), true);
});

test('beginDrain is idempotent', async () => {
    const tracker = createRequestTracker();

    tracker.beginDrain();
    tracker.beginDrain();

    await tracker.whenIdle();

    assert.equal(tracker.isDraining(), true);
    assert.equal(tracker.getActiveCount(), 0);
});

test('invalid handler is rejected', () => {
    const tracker = createRequestTracker();

    assert.throws(
        () => tracker.track(null),
        TypeError
    );
});
