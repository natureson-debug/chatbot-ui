'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
    path.join(root, 'server.js'),
    'utf8'
);

function deferred() {
    let resolve;

    const promise = new Promise((yes) => {
        resolve = yes;
    });

    return { promise, resolve };
}

function setup({ readFileError = null } = {}) {
    let handler;
    let pendingRead;
    let tracker;

    const mockFs = {
        readFile(file, callback) {
            if (readFileError) {
                throw readFileError;
            }

            pendingRead = { file, callback };
        },
        readFileSync() {
            throw new Error('Unexpected synchronous read');
        }
    };

    const dependencies = {
        './db': { db: {} },
        './auth': {},
        './core/config': {
            HOST: '127.0.0.1',
            PORT: 0
        },
        './core/llama-client': {},
        './core/llama-runtime': {},
        './core/admin-telemetry': {},
        './core/ai-activation': {},

        './core/request-tracker': {
            createRequestTracker() {
                tracker = require('../core/request-tracker')
                    .createRequestTracker();

                return tracker;
            }
        },

        './core/http-error-boundary':
            require('../core/http-error-boundary')
    };

    vm.runInNewContext(source, {
        __dirname: root,
        Buffer,
        AbortController,
        console: {
            log() {},
            error() {}
        },

        require(name) {
            if (name === 'http') {
                return {
                    createServer(fn) {
                        handler = fn;
                        return { listen() {} };
                    }
                };
            }

            if (name === 'fs') return mockFs;

            if (Object.hasOwn(dependencies, name)) {
                return dependencies[name];
            }

            return require(name);
        }
    }, {
        filename: 'server.js'
    });

    function request(url = '/') {
        const req = {
            method: 'GET',
            url,
            headers: {}
        };

        const res = new EventEmitter();

        res.statusCode = null;
        res.headers = {};
        res.headersSent = false;
        res.destroyed = false;
        res.writableEnded = false;
        res.writableFinished = false;
        res.chunks = [];

        res.writeHead = function (status, headers = {}) {
            assert.equal(this.destroyed, false);
            this.statusCode = status;
            this.headers = headers;
            this.headersSent = true;
            return this;
        };

        res.end = function (chunk) {
            assert.equal(this.destroyed, false);

            if (chunk !== undefined) {
                this.chunks.push(Buffer.from(chunk));
            }

            this.headersSent = true;
            this.writableEnded = true;
            this.writableFinished = true;
            this.emit('finish');
            this.emit('close');

            return this;
        };

        res.disconnect = function () {
            this.destroyed = true;
            this.emit('close');
        };

        const finished = handler(req, res);

        return { res, finished };
    }

    return {
        request,
        tracker,
        getPendingRead() {
            return pendingRead;
        }
    };
}

test('successful static file delivery', async () => {
    const s = setup();
    const { res, finished } = s.request('/');

    const read = s.getPendingRead();

    assert.ok(read);
    assert.equal(path.basename(read.file), 'index.html');
    assert.equal(s.tracker.getActiveCount(), 1);

    read.callback(null, Buffer.from('<h1>OK</h1>'));

    await finished;

    assert.equal(res.statusCode, 200);
    assert.equal(
        res.headers['Content-Type'],
        'text/html; charset=utf-8'
    );
    assert.equal(
        Buffer.concat(res.chunks).toString(),
        '<h1>OK</h1>'
    );
    assert.equal(s.tracker.getActiveCount(), 0);
});

test('missing static file returns 404', async () => {
    const s = setup();
    const { res, finished } = s.request('/missing.css');

    s.getPendingRead().callback(
        Object.assign(new Error('ENOENT'), {
            code: 'ENOENT'
        })
    );

    await finished;

    assert.equal(res.statusCode, 404);
    assert.equal(
        Buffer.concat(res.chunks).toString(),
        'Not found'
    );
    assert.equal(s.tracker.getActiveCount(), 0);
});

test('disconnect does not write after pending read', async () => {
    const s = setup();
    const { res, finished } = s.request('/');

    res.disconnect();

    assert.equal(s.tracker.getActiveCount(), 1);

    s.getPendingRead().callback(
        null,
        Buffer.from('late data')
    );

    await finished;

    assert.equal(res.statusCode, null);
    assert.equal(res.chunks.length, 0);
    assert.equal(s.tracker.getActiveCount(), 0);
});

test('tracker remains active until filesystem callback', async () => {
    const s = setup();
    const { res, finished } = s.request('/');

    const idle = deferred();
    let becameIdle = false;

    s.tracker.whenIdle().then(() => {
        becameIdle = true;
        idle.resolve();
    });

    res.disconnect();

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(becameIdle, false);
    assert.equal(s.tracker.getActiveCount(), 1);

    s.getPendingRead().callback(
        null,
        Buffer.from('completed')
    );

    await finished;
    await idle.promise;

    assert.equal(becameIdle, true);
    assert.equal(s.tracker.getActiveCount(), 0);
});

test('filesystem callback response error is caught by boundary', async () => {
    const s = setup();
    const { res, finished } = s.request('/');

    const originalWriteHead = res.writeHead;
    let attempts = 0;

    res.writeHead = function (...args) {
        attempts++;

        if (attempts === 1) {
            throw new Error('Synthetic response failure');
        }

        return originalWriteHead.apply(this, args);
    };

    s.getPendingRead().callback(
        null,
        Buffer.from('test')
    );

    await finished;

    assert.equal(attempts, 2);
    assert.equal(res.statusCode, 500);
    assert.equal(
        Buffer.concat(res.chunks).toString(),
        JSON.stringify({
            error: 'Internal server error'
        })
    );
    assert.equal(s.tracker.getActiveCount(), 0);
});

test('synchronous fs.readFile failure returns sanitized 500', async () => {
    const s = setup({
        readFileError: new Error('Synthetic filesystem failure')
    });

    const { res, finished } = s.request('/');

    await finished;

    assert.equal(res.statusCode, 500);

    assert.equal(
        res.headers['Content-Type'],
        'application/json; charset=utf-8'
    );

    assert.deepEqual(
        JSON.parse(Buffer.concat(res.chunks).toString()),
        { error: 'Internal server error' }
    );

    assert.equal(s.tracker.getActiveCount(), 0);
});

test('Windows static admin aliases and alternate streams are denied without file reads', async () => {
    for (const url of ['/ADMIN.HTML','//admin.html','/x/../admin.html','/admin.html.','/admin.html:stream','/%61dmin.html']) {
        const h = setup();
        const r = h.request(url);
        // Each handler is synchronous until a read; an unsafe route would remain pending.
        assert.equal(h.getPendingRead(), undefined);
        await r.finished;
        assert.ok([403,404].includes(r.res.statusCode), url);
    }
});
