'use strict';

function createSystemLogRoute({ logs, validate, authenticate, revalidate }) {
    if (!logs || typeof logs.list !== 'function' || typeof validate !== 'function' ||
        typeof authenticate !== 'function' || typeof revalidate !== 'function') {
        throw new TypeError('System logs and authentication functions are required');
    }

    return function handleSystemLogRoute(req, res) {
        let url;
        try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
        if (url.pathname !== '/api/admin/system-logs') return false;
        const reply = (status, data) => {
            res.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify(data));
        };
        if (req.method !== 'GET') {
            reply(405, { error: 'Method not allowed' });
            return true;
        }

        let admin;
        try { admin = authenticate(req); } catch {
            reply(500, { error: 'System logs unavailable' });
            return true;
        }
        if (!admin || admin.is_admin !== 1) {
            logs.log('AUTH_ADMIN_ACCESS_DENIED', {
                actorId: admin?.id,
                metadata: {
                    resource: 'system_logs',
                    reason: admin ? 'not_administrator' : 'unauthenticated'
                }
            });
            reply(admin ? 403 : 401, { error: 'Administrator access required' });
            return true;
        }

        const filters = {};
        const parameters = {
            severity: 'severity', category: 'category', eventCode: 'eventCode',
            from: 'from', to: 'to', providerId: 'providerId', correlationId: 'correlationId',
            page: 'page', pageSize: 'pageSize'
        };
        const allowed = new Set(Object.keys(parameters));
        if ([...url.searchParams.keys()].some(parameter => !allowed.has(parameter))) {
            reply(400, { error: 'Invalid log query' });
            return true;
        }
        for (const [parameter, key] of Object.entries(parameters)) {
            const values = url.searchParams.getAll(parameter);
            if (values.length > 1) {
                reply(400, { error: 'Invalid log query' });
                return true;
            }
            if (values.length === 1) filters[key] = values[0];
        }

        let validated;
        try { validated = validate(filters); } catch {
            reply(400, { error: 'Invalid log query' });
            return true;
        }
        let result;
        try { result = logs.list(validated); } catch {
            reply(500, { error: 'System logs unavailable' });
            return true;
        }
        let current;
        try { current = revalidate(req); } catch {
            reply(500, { error: 'System logs unavailable' });
            return true;
        }
        if (!current || current.id !== admin.id || current.is_admin !== 1) {
            logs.log('AUTH_ADMIN_ACCESS_DENIED', {
                actorId: admin.id,
                metadata: { resource: 'system_logs', reason: 'session_revoked' }
            });
            reply(401, { error: 'Session no longer authorized' });
            return true;
        }
        reply(200, result);
        return true;
    };
}

module.exports = { createSystemLogRoute };
