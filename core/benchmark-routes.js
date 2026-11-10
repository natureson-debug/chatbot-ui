'use strict';

const { validateBenchmark, exportCsv } = require('./benchmark-runner');
const reports = require('./benchmark-reports');

function createBenchmarkRoutes({ runner, authenticate, revalidate, logAdminAccessDenied = () => {} }) {
    if (!runner || typeof runner.start !== 'function' || typeof runner.getRun !== 'function' ||
        typeof runner.listRuns !== 'function' || typeof runner.cancel !== 'function' ||
        typeof authenticate !== 'function' || typeof revalidate !== 'function') {
        throw new TypeError('Benchmark and authentication services are required');
    }

    return async function handleBenchmarkRoute(req, res) {
        let url;
        try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
        if (url.pathname !== '/api/admin/benchmarks' &&
            !url.pathname.startsWith('/api/admin/benchmarks/')) return false;
        const reply = (status, data, headers = {}) => {
            res.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                ...headers
            });
            res.end(JSON.stringify(data));
        };
        let admin;
        try { admin = authenticate(req); } catch {
            reply(500, { error: 'Benchmark service unavailable' });
            return true;
        }
        if (!admin || admin.is_admin !== 1) {
            try { logAdminAccessDenied(req, admin); } catch {}
            reply(admin ? 403 : 401, { error: 'Administrator access required' });
            return true;
        }
        const stillAdmin = () => {
            const current = revalidate(req);
            return !!current && current.id === admin.id && current.is_admin === 1;
        };
        const route = url.pathname.slice('/api/admin/benchmarks'.length);
        if (req.method === 'GET' && route === '') {
            if ([...url.searchParams.keys()].some(key => key !== 'limit') || url.searchParams.getAll('limit').length > 1) {
                reply(400, { error: 'Invalid benchmark query' });
                return true;
            }
            const rawLimit = url.searchParams.get('limit');
            const limit = rawLimit === null ? 20 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
                reply(400, { error: 'Invalid benchmark query' });
                return true;
            }
            let runs;
            try { runs = runner.listRuns(limit); } catch {
                reply(500, { error: 'Benchmark service unavailable' });
                return true;
            }
            try {
                if (!stillAdmin()) {
                    reply(401, { error: 'Session no longer authorized' });
                    return true;
                }
            } catch {
                reply(500, { error: 'Benchmark service unavailable' });
                return true;
            }
            reply(200, { runs });
            return true;
        }
        if (req.method === 'POST' && route === '/start') {
            let body = '';
            try {
                for await (const chunk of req) {
                    body += chunk;
                    if (Buffer.byteLength(body) > 8192) {
                        reply(413, { error: 'Benchmark configuration too large' });
                        return true;
                    }
                }
            } catch {
                reply(400, { error: 'Invalid benchmark configuration' });
                return true;
            }
            let input;
            try { input = JSON.parse(body); } catch {
                reply(400, { error: 'Invalid benchmark configuration' });
                return true;
            }
            try { validateBenchmark(input); } catch {
                reply(400, { error: 'Invalid benchmark configuration' });
                return true;
            }
            try {
                const run = await runner.start(admin.id, input, () => stillAdmin());
                if (!stillAdmin()) {
                    runner.cancel(run.runId);
                    reply(401, { error: 'Session no longer authorized' });
                    return true;
                }
                reply(202, { run });
            } catch (error) {
                if (error?.code === 'benchmark_active' || error?.code === 'server_busy') {
                    reply(409, { error: error.code === 'server_busy'
                        ? 'Local inference server is busy' : 'A benchmark is already active' });
                } else if (error?.code === 'busy_state_unavailable' || error?.code === 'model_unavailable') {
                    reply(503, { error: 'Local inference server is unavailable for benchmarking' });
                } else if (error?.code === 'session_revoked') {
                    reply(401, { error: 'Session no longer authorized' });
                } else {
                    reply(500, { error: 'Benchmark service unavailable' });
                }
            }
            return true;
        }

        const match = route.match(/^\/([0-9a-f-]{36})(?:\/(cancel|export))?$/i);
        if (!match) {
            reply(404, { error: 'Benchmark run not found' });
            return true;
        }
        const [, runId, action] = match;
        if (action === 'cancel') {
            if (req.method !== 'POST' || url.search) {
                reply(405, { error: 'Method not allowed' });
                return true;
            }
            try {
                if (!stillAdmin()) {
                    reply(401, { error: 'Session no longer authorized' });
                    return true;
                }
            } catch {
                reply(500, { error: 'Benchmark service unavailable' });
                return true;
            }
            const cancelled = runner.cancel(runId);
            const run = runner.getRun(runId);
            if (!run) {
                reply(404, { error: 'Benchmark run not found' });
                return true;
            }
            reply(200, { cancelled, run });
            return true;
        }
        if (action === 'export') {
            if (req.method !== 'GET' || [...url.searchParams.keys()].some(key => key !== 'format') ||
                url.searchParams.getAll('format').length > 1) {
                reply(400, { error: 'Invalid export request' });
                return true;
            }
            const format = url.searchParams.get('format') || 'json';
            if (!['csv', 'json', 'xlsx', 'pdf'].includes(format)) {
                reply(400, { error: 'Unsupported export format' });
                return true;
            }
            const run = runner.getRun(runId);
            if (!run) {
                reply(404, { error: 'Benchmark run not found' });
                return true;
            }
            if (run.status !== 'completed') {
                reply(409, { error: 'Only completed benchmark runs can be exported' });
                return true;
            }
            try {
                if (!stillAdmin()) {
                    reply(401, { error: 'Session no longer authorized' });
                    return true;
                }
            } catch {
                reply(500, { error: 'Benchmark service unavailable' });
                return true;
            }
            let data;
            try {
                data = format === 'xlsx' ? await reports.xlsx(run) : format === 'pdf' ? reports.pdf(run) :
                    format === 'csv' ? exportCsv(run) : JSON.stringify(run);
                if (!stillAdmin()) { reply(401, { error: 'Session no longer authorized' }); return true; }
            } catch { reply(500, { error: 'Benchmark report unavailable' }); return true; }
            const type = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8',
                xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' }[format];
            const filename = `benchmark-${run.runId}.${format}`;
            res.writeHead(200, {
                'Content-Type': type,
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Cache-Control': 'no-store'
            });
            res.end(data);
            return true;
        }
        if (req.method !== 'GET' || url.search) {
            reply(405, { error: 'Method not allowed' });
            return true;
        }
        const run = runner.getRun(runId);
        if (!run) {
            reply(404, { error: 'Benchmark run not found' });
            return true;
        }
        try {
            if (!stillAdmin()) {
                reply(401, { error: 'Session no longer authorized' });
                return true;
            }
        } catch {
            reply(500, { error: 'Benchmark service unavailable' });
            return true;
        }
        reply(200, { run });
        return true;
    };
}

module.exports = { createBenchmarkRoutes };
