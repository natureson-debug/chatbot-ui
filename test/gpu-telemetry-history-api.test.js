'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

test('GPU telemetry history endpoint authorization', async () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const begin = source.indexOf('// Read-only GPU telemetry history;');
    const end = source.indexOf('// Read-only telemetry;', begin);
    
    async function route(user, current = user, url = '/api/admin/ai/telemetry/history/5m') {
        let code, body, headers;
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE gpu_telemetry (id INT, gpu_index INT, sampled_at TEXT, sampled_at_unix_ms INT)');
        
        const run = vm.runInNewContext('(async()=>{' + source.slice(begin, end) + '})', {
            req: { method: 'GET', url, headers: {} },
            res: {
                writeHead(c, h) { code = c; headers = h; },
                end(b) { body = JSON.parse(b); }
            },
            getSessionToken: () => 'synthetic',
            getAuthenticatedUser: () => user,
            getSessionUser: () => current,
            db,
            logAdminAccessDenied() {},
            logSystemEvent() {},
            gpuTelemetryStorage: {
                getHistory: () => [],
                getStatistics: () => ({ total_samples: 0, distinct_times: 0, earliest_ms: null, latest_ms: null })
            }
        });
        await run();
        return { code, body, headers };
    }
    
    // Anonymous access rejected
    const anonResult = await route(null);
    assert.equal(anonResult.code, 401);
    
    // Non-admin access rejected
    const userResult = await route({ id: 'user1', is_admin: 0 });
    assert.equal(userResult.code, 403);
    
    // Admin access allowed
    const adminResult = await route({ id: 'admin1', is_admin: 1 });
    assert.equal(adminResult.code, 200);
    assert.equal(adminResult.headers['Cache-Control'], 'no-store');
});

test('GPU telemetry history endpoint supports multiple time ranges', async () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const begin = source.indexOf('// Read-only GPU telemetry history;');
    const end = source.indexOf('// Read-only telemetry;', begin);
    
    async function route(range) {
        let code, body, headers;
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE gpu_telemetry (id INT, gpu_index INT, sampled_at TEXT, sampled_at_unix_ms INT)');
        
        const url = `/api/admin/ai/telemetry/history/${range}`;
        const run = vm.runInNewContext('(async()=>{' + source.slice(begin, end) + '})', {
            req: { method: 'GET', url, headers: {} },
            res: {
                writeHead(c, h) { code = c; headers = h; },
                end(b) { body = JSON.parse(b); }
            },
            getSessionToken: () => 'synthetic',
            getAuthenticatedUser: () => ({ id: 'admin1', is_admin: 1 }),
            getSessionUser: () => ({ id: 'admin1', is_admin: 1 }),
            db,
            logAdminAccessDenied() {},
            logSystemEvent() {},
            gpuTelemetryStorage: {
                getHistory: (timeRangeMs) => [],
                getStatistics: (timeRangeMs) => ({ total_samples: 0, distinct_times: 0, earliest_ms: null, latest_ms: null })
            }
        });
        await run();
        return { code, body };
    }
    
    // 5 minute range
    const result5m = await route('5m');
    assert.equal(result5m.code, 200);
    assert.equal(result5m.body.range, '5m');
    assert.equal(result5m.body.timeRangeMs, 5 * 60 * 1000);
    
    // 30 minute range
    const result30m = await route('30m');
    assert.equal(result30m.code, 200);
    assert.equal(result30m.body.range, '30m');
    assert.equal(result30m.body.timeRangeMs, 30 * 60 * 1000);
    
    // 1 hour range
    const result1h = await route('1h');
    assert.equal(result1h.code, 200);
    assert.equal(result1h.body.range, '1h');
    assert.equal(result1h.body.timeRangeMs, 60 * 60 * 1000);
});

test('GPU telemetry history endpoint session revalidation', async () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const begin = source.indexOf('// Read-only GPU telemetry history;');
    const end = source.indexOf('// Read-only telemetry;', begin);
    
    async function route(admin, current) {
        let code, body, headers;
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE gpu_telemetry (id INT, gpu_index INT, sampled_at TEXT, sampled_at_unix_ms INT)');
        
        const run = vm.runInNewContext('(async()=>{' + source.slice(begin, end) + '})', {
            req: { method: 'GET', url: '/api/admin/ai/telemetry/history/5m', headers: {} },
            res: {
                writeHead(c, h) { code = c; headers = h; },
                end(b) { body = JSON.parse(b); }
            },
            getSessionToken: () => 'synthetic',
            getAuthenticatedUser: () => admin,
            getSessionUser: () => current,
            db,
            logAdminAccessDenied() {},
            logSystemEvent() {},
            gpuTelemetryStorage: {
                getHistory: () => [],
                getStatistics: () => ({ total_samples: 0, distinct_times: 0, earliest_ms: null, latest_ms: null })
            }
        });
        await run();
        return { code, body };
    }
    
    // Session revoked
    const result = await route({ id: 'admin1', is_admin: 1 }, null);
    assert.equal(result.code, 401);
});

test('GPU telemetry history endpoint returns structured response', async () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const begin = source.indexOf('// Read-only GPU telemetry history;');
    const end = source.indexOf('// Read-only telemetry;', begin);
    
    let code, body, headers;
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE gpu_telemetry (id INT, gpu_index INT, sampled_at TEXT, sampled_at_unix_ms INT)');
    
    const mockSamples = [
        { sampled_at: '2026-11-10T10:00:00Z', gpu_index: 0, utilization_percent: 50 },
        { sampled_at: '2026-11-10T10:05:00Z', gpu_index: 0, utilization_percent: 60 }
    ];
    
    const run = vm.runInNewContext('(async()=>{' + source.slice(begin, end) + '})', {
        req: { method: 'GET', url: '/api/admin/ai/telemetry/history/5m', headers: {} },
        res: {
            writeHead(c, h) { code = c; headers = h; },
            end(b) { body = JSON.parse(b); }
        },
        getSessionToken: () => 'synthetic',
        getAuthenticatedUser: () => ({ id: 'admin1', is_admin: 1 }),
        getSessionUser: () => ({ id: 'admin1', is_admin: 1 }),
        db,
        logAdminAccessDenied() {},
        logSystemEvent() {},
        gpuTelemetryStorage: {
            getHistory: () => mockSamples,
            getStatistics: () => ({ total_samples: 2, distinct_times: 2, earliest_ms: 1000, latest_ms: 2000 })
        }
    });
    await run();
    
    assert.equal(code, 200);
    assert.equal(body.range, '5m');
    assert.equal(body.timeRangeMs, 5 * 60 * 1000);
    assert.equal(body.samples.length, 2);
    assert(body.statistics);
    assert.equal(body.statistics.total_samples, 2);
    assert.equal(body.statistics.distinct_times, 2);
});

test('GPU telemetry history endpoint handles storage errors', async () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const begin = source.indexOf('// Read-only GPU telemetry history;');
    const end = source.indexOf('// Read-only telemetry;', begin);
    
    let code, body;
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE gpu_telemetry (id INT, gpu_index INT, sampled_at TEXT, sampled_at_unix_ms INT)');
    
    const run = vm.runInNewContext('(async()=>{' + source.slice(begin, end) + '})', {
        req: { method: 'GET', url: '/api/admin/ai/telemetry/history/5m', headers: {} },
        res: {
            writeHead(c) { code = c; },
            end(b) { body = JSON.parse(b); }
        },
        getSessionToken: () => 'synthetic',
        getAuthenticatedUser: () => ({ id: 'admin1', is_admin: 1 }),
        getSessionUser: () => ({ id: 'admin1', is_admin: 1 }),
        db,
        logAdminAccessDenied() {},
        logSystemEvent() {},
        gpuTelemetryStorage: {
            getHistory: () => { throw new Error('Database error'); },
            getStatistics: () => { throw new Error('Database error'); }
        },
        console: { error: () => {} }
    });
    await run();
    
    assert.equal(code, 500);
    assert(body.error);
});
