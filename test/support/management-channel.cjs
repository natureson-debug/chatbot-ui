'use strict';
// TEST infrastructure only. No production imports, child processes, PID or task APIs.
const http = require('node:http');
const crypto = require('node:crypto');
const { createActivationContract } = require('./activation-contract.cjs');
const digest = /^[a-f0-9]{64}$/;
const id = /^[a-zA-Z0-9-]{1,64}$/;
const outcome = (state, code) => ({ version: 1, mode: 'TEST', state, code, productionReady: false });
function mac(key, domain, text) {
    return crypto.createHmac('sha256', key).update(domain + '\n' + text).digest('hex');
}
function matches(key, domain, text, signature) {
    return typeof signature === 'string' && digest.test(signature) &&
        crypto.timingSafeEqual(Buffer.from(mac(key, domain, text), 'hex'), Buffer.from(signature, 'hex'));
}
function createTestBoundary({ mode, leaseVerified, observe, broker, now = Date.now,
    timeoutMs = 1000, schedule = setTimeout, cancel = clearTimeout }) {
    if (mode !== 'TEST' || ![leaseVerified, observe, broker, now, schedule, cancel].every(f => typeof f === 'function') ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('TEST providers required');
    const contract = createActivationContract({ mode, now });
    let busy = false, poisoned = false;
    const seen = new Set();
    return Object.freeze({
        invalidate() { poisoned = true; },
        // All TEST lifecycle entry points (activation/start/stop/recovery) use this same object.
        async run(request) {
            if (poisoned) return outcome('unverifiable', 'CHANNEL_POISONED');
            if (busy) return outcome('conflicting', 'OPERATION_BUSY');
            if (seen.has(request.operationId)) return outcome('rejected', 'REPLAY');
            if (seen.size >= 1024) return outcome('unverifiable', 'SESSION_CAPACITY');
            busy = true; seen.add(request.operationId);
            let active = true, timer, sequence = 0;
            const started = now();
            const end = started + timeoutMs;
            const check = () => {
                if (!Number.isSafeInteger(now()) || now() < started || !active || poisoned || now() >= end || (request.expiresAt !== undefined && now() >= request.expiresAt) || leaseVerified() !== true) throw Error('UNVERIFIABLE');
            };
            const work = async () => {
                check();
                const evidence = await observe(request);
                check();
                const admission = contract.validateRequest(request, evidence);
                if (!admission.allowed) return outcome('rejected', admission.code);
                // No effect from observation; the sole command entry checks capability each time.
                const command = async name => {
                    check();
                    if (!['STATUS', 'STOP', 'START'].includes(name)) throw Error('INVALID_COMMAND');
                    const seq = ++sequence;
                    const reply = await broker({ operationId: request.operationId, sequence: seq, command: name });
                    check();
                    if (!reply || reply.operationId !== request.operationId || reply.sequence !== seq) throw Error('INVALID_REPLY');
                    return reply;
                };
                // This stage qualifies authenticated dispatch only, never executes STOP/START.
                const reply = await command('STATUS');
                if (reply.status !== 'owned') throw Error('OWNERSHIP_LOST');
                return outcome('accepted', 'SIMULATED_DISPATCH_ACCEPTED');
            };
            try {
                return await Promise.race([work(), new Promise(resolve => {
                    timer = schedule(() => {
                        active = false; poisoned = true;
                        resolve(outcome('timed-out', 'OPERATION_TIMEOUT'));
                    }, timeoutMs);
                })]);
            } catch (_) {
                poisoned = true;
                return outcome('unverifiable', 'PROVIDER_UNVERIFIABLE');
            } finally {
                active = false; cancel(timer);
                // Never release an uncertain operation for replacement or reuse this session.
                if (!poisoned) busy = false;
            }
        }
    });
}
async function openTestChannel({ mode, boundary, now = Date.now, actor = 'fixture-admin' }) {
    if (mode !== 'TEST' || !boundary || typeof boundary.run !== 'function') throw Error('TEST boundary required');
    const key = crypto.randomBytes(32), session = crypto.randomUUID();
    let closed = false;
    const server = http.createServer(async (req, res) => {
        const send = result => {
            const body = JSON.stringify(result);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                'X-Test-Response-Mac': mac(key, 'response:' + session, body) });
            res.end(body);
        };
        if (req.socket.remoteAddress !== '127.0.0.1' || req.method !== 'POST' || req.url !== '/test-management' ||
            req.headers.origin || req.headers['content-type'] !== 'application/json') {
            send(outcome('rejected', 'INVALID_CHANNEL_REQUEST')); return;
        }
        let chunks = [], bytes = 0;
        try {
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 4096) { send(outcome('rejected', 'OVERSIZE')); req.destroy(); return; }
                chunks.push(chunk);
            }
            const body = Buffer.concat(chunks).toString('utf8');
            if (!matches(key, 'request:' + session, body, req.headers['x-test-request-mac'])) {
                send(outcome('rejected', 'UNAUTHENTICATED')); return;
            }
            const r = JSON.parse(body);
            const fields = ['version','session','actor','operationId','action','expectedRevision','profileDigest','issuedAt','expiresAt'];
            if (!r || Array.isArray(r) || Object.keys(r).length !== fields.length || fields.some(k => !Object.hasOwn(r,k)) ||
                r.version !== 1 || r.session !== session || typeof r.operationId !== 'string' || !id.test(r.operationId) ||
                !['activate','start','stop','recovery'].includes(r.action) || !Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 0 ||
                typeof r.profileDigest !== 'string' || !digest.test(r.profileDigest) || !Number.isSafeInteger(r.issuedAt) || !Number.isSafeInteger(r.expiresAt)) {
                send(outcome('rejected', 'MALFORMED')); return;
            }
            if (r.actor !== actor) { send(outcome('rejected', 'UNAUTHORIZED')); return; }
            if (!Number.isSafeInteger(now()) || r.issuedAt > now() || r.expiresAt <= now() || r.expiresAt <= r.issuedAt || r.expiresAt-r.issuedAt > 30000) {
                send(outcome('rejected', 'EXPIRED')); return;
            }
            res.once('close', () => { if (!res.writableEnded) boundary.invalidate(); });
            send(await boundary.run(Object.freeze(r)));
        } catch (_) { if (!res.headersSent) send(outcome('rejected', 'MALFORMED')); }
    });
    server.requestTimeout = 2000; server.headersTimeout = 2000; server.timeout = 2000;
    server.maxConnections = 8;
    await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
    // In-memory fixture capability only; never serialize/store this closure or key.
    return {
        address: server.address(),
        async request(overrides = {}, { badMac = false, raw } = {}) {
            if (closed) return outcome('unverifiable','CHANNEL_UNAVAILABLE');
            const body = raw ?? JSON.stringify({ version:1, session, actor, operationId:crypto.randomUUID(), action:'activate',
                expectedRevision:2, profileDigest:'a'.repeat(64), issuedAt:now(), expiresAt:now()+1000, ...overrides });
            try {
                const response = await fetch('http://127.0.0.1:' + server.address().port + '/test-management', {
                    method:'POST', headers:{'Content-Type':'application/json','X-Test-Request-Mac':badMac?'0'.repeat(64):mac(key,'request:'+session,body)},
                    body, signal:AbortSignal.timeout(3000)
                });
                const text = await response.text();
                if (!matches(key,'response:'+session,text,response.headers.get('x-test-response-mac'))) return outcome('unverifiable','RESPONSE_AUTHENTICATION');
                return JSON.parse(text);
            } catch (_) { return outcome('unverifiable','CHANNEL_UNAVAILABLE'); }
        },
        async close() {
            closed = true; boundary.invalidate();
            await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
            key.fill(0);
        }
    };
}
module.exports = { createTestBoundary, openTestChannel };
