'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
    withHttpErrorBoundary
} = require('../core/http-error-boundary');

function response() {
    const res = new EventEmitter();

    res.destroyed = false;
    res.writableEnded = false;
    res.headersSent = false;
    res.statusCode = null;
    res.body = '';

    res.writeHead = function (status) {
        this.statusCode = status;
        this.headersSent = true;
        return this;
    };

    res.end = function (body = '') {
        this.body += body;
        this.writableEnded = true;
        this.emit('finish');
        return this;
    };

    res.destroy = function () {
        this.destroyed = true;
        this.emit('close');
        return this;
    };

    return res;
}

test('successful handler passes through unchanged', async () => {
    const guarded = withHttpErrorBoundary(
        async (_req, res) => {
            res.writeHead(200);
            res.end('ok');
        },
        { logError() {} }
    );

    const res = response();

    await guarded({}, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'ok');
    assert.equal(res.destroyed, false);
});

test('rejected handler returns sanitized HTTP 500', async () => {
    const errors = [];

    const guarded = withHttpErrorBoundary(
        async () => {
            throw new Error('private internal detail');
        },
        {
            logError(...args) {
                errors.push(args);
            }
        }
    );

    const res = response();

    await guarded({}, res);

    assert.equal(res.statusCode, 500);
    assert.deepEqual(JSON.parse(res.body), {
        error: 'Internal server error'
    });

    assert.equal(res.body.includes('private'), false);
    assert.equal(errors.length, 1);
});

test('failure after headers destroys response without adding JSON', async () => {
    const guarded = withHttpErrorBoundary(
        async (_req, res) => {
            res.writeHead(200);
            throw new Error('stream failure');
        },
        { logError() {} }
    );

    const res = response();

    await guarded({}, res);

    assert.equal(res.destroyed, true);
    assert.equal(res.body, '');
});

test('disconnected response is not written again', async () => {
    const guarded = withHttpErrorBoundary(
        async (_req, res) => {
            res.destroy();
            throw new Error('late failure');
        },
        { logError() {} }
    );

    const res = response();

    await guarded({}, res);

    assert.equal(res.destroyed, true);
    assert.equal(res.statusCode, null);
});

test('invalid handler is rejected', () => {
    assert.throws(
        () => withHttpErrorBoundary(null),
        TypeError
    );
});

test('throwing diagnostic sink does not escape error boundary', async () => {
    const res=response();
    await withHttpErrorBoundary(async()=>{throw Error('private')},{logError(){throw Error('logger')}})({},res);
    assert.equal(res.statusCode,500);
});
