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
    let reject;

    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });

    return { promise, resolve, reject };
}

function setup(createChatCompletion) {
    let handler;

    const modelsDir = path.join(root, 'synthetic-models');
    const configFile = path.join(root, 'synthetic-ai-config.json');

    const mockFs = {
        readFileSync(file) {
            if (String(file) === configFile) {
                return JSON.stringify({ model: 'test.gguf' });
            }
            throw new Error('Unexpected filesystem read: ' + file);
        },

        readdirSync(dir) {
            assert.equal(String(dir), modelsDir);
            return ['test.gguf'];
        }
    };

    const dependencies = {
        './db': { db: {} },

        './auth': {
            getSessionToken: () => 'synthetic-session',
            getSessionUser: () => ({
                id: 'synthetic-user',
                is_admin: 0
            })
        },

        './core/config': {
            HOST: '127.0.0.1',
            PORT: 0,
            LLAMA_URL: 'http://127.0.0.1:18080/v1/chat/completions',
            LLAMA_BIND_HOST: '127.0.0.1',
            LLAMA_PORT: 18080,
            AI_CONFIG_FILE: configFile,
            MODELS_DIR: modelsDir
        },

        './core/llama-client': {
            createChatCompletion,
            getHealth: async () => ({ status: 'ok' }),
            getReportedModel: async () => null
        },

        './core/llama-runtime': {
            getLlamaServerPid: () => null
        },

        './core/admin-telemetry': {},
        './core/ai-activation': {
            blockedActivation: async () => ({
                state: 'blocked'
            })
        },

        './core/request-tracker': require('../core/request-tracker'),
        './core/http-error-boundary': require('../core/http-error-boundary')
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

    assert.equal(typeof handler, 'function');

    function request() {
        const req = {
            method: 'POST',
            url: '/api/chat',
            headers: {
                cookie: 'chatbot_session=synthetic-session'
            },

            async *[Symbol.asyncIterator]() {
                yield JSON.stringify({
                    messages: [
                        { role: 'user', content: 'test' }
                    ]
                });
            }
        };

        const res = new EventEmitter();

        res.statusCode = null;
        res.headers = {};
        res.headersSent = false;
        res.destroyed = false;
        res.writableFinished = false;
        res.chunks = [];

        res.writeHead = function (status, headers) {
            this.statusCode = status;
            this.headers = headers;
            this.headersSent = true;
            return this;
        };

        res.write = function (chunk) {
            assert.equal(this.destroyed, false);
            this.chunks.push(Buffer.from(chunk));
            return true;
        };

        res.end = function (chunk) {
            if (chunk !== undefined) {
                this.chunks.push(Buffer.from(chunk));
            }

            this.headersSent = true;
            this.writableFinished = true;
            this.emit('close');
            return this;
        };

        res.disconnect = function () {
            this.destroyed = true;
            this.emit('close');
        };

        const finished = handler(req, res);

        return { req, res, finished };
    }

    return { request };
}

function streamingResponse(reader) {
    return {
        ok: true,
        status: 200,
        body: {
            getReader() {
                return reader;
            }
        }
    };
}

test('normal SSE completion does not abort upstream', async () => {
    let signal;

    const s = setup(async (_request, options) => {
        signal = options.signal;

        return streamingResponse({
            async read() {
                if (!this.sent) {
                    this.sent = true;
                    return {
                        done: false,
                        value: Buffer.from('data: hello\n\n')
                    };
                }

                return { done: true };
            }
        });
    });

    const { res, finished } = s.request();

    await finished;

    assert.equal(res.statusCode, 200);
    assert.equal(
        res.headers['Content-Type'],
        'text/event-stream'
    );
    assert.equal(
        Buffer.concat(res.chunks).toString(),
        'data: hello\n\n'
    );

    assert.equal(res.writableFinished, true);
    assert.equal(signal.aborted, false);
    assert.equal(res.listenerCount('close'), 0);
});

test('browser disconnect aborts active SSE stream', async () => {
    const reading = deferred();
    const enteredRead = deferred();

    let signal;

    const s = setup(async (_request, options) => {
        signal = options.signal;

        signal.addEventListener('abort', () => {
            reading.reject(
                Object.assign(new Error('Aborted'), {
                    name: 'AbortError'
                })
            );
        }, { once: true });

        return streamingResponse({
            read() {
                enteredRead.resolve();
                return reading.promise;
            }
        });
    });

    const { res, finished } = s.request();

    await enteredRead.promise;

    assert.equal(signal.aborted, false);

    res.disconnect();

    await finished;

    assert.equal(signal.aborted, true);
    assert.equal(res.writableFinished, false);
    assert.equal(res.listenerCount('close'), 0);
});

test('browser disconnect aborts pending upstream request', async () => {
    const started = deferred();

    let signal;

    const s = setup((_request, options) => {
        signal = options.signal;
        started.resolve();

        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(
                    Object.assign(new Error('Aborted'), {
                        name: 'AbortError'
                    })
                );
            }, { once: true });
        });
    });

    const { res, finished } = s.request();

    await started.promise;

    assert.equal(signal.aborted, false);

    res.disconnect();

    await finished;

    assert.equal(signal.aborted, true);
    assert.equal(res.writableFinished, false);
    assert.equal(res.listenerCount('close'), 0);
});

test('upstream exception details are not exposed', async () => {
    const s = setup(async () => { throw new Error('SECRET_SYNTHETIC_DETAIL'); });
    const {res, finished} = s.request(); await finished;
    const text=Buffer.concat(res.chunks).toString();
    assert.ok(!text.includes('SECRET_SYNTHETIC_DETAIL'));
    assert.ok(text.includes('Inference service unavailable'));
});
