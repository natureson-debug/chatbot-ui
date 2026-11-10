'use strict';

const { randomUUID } = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 30 * DAY_MS;
const DEFAULT_MAX_EVENTS = 50000;
const MAX_PAGE_SIZE = 100;
const MAX_QUEUE_SIZE = 1000;
const PRUNE_BATCH_SIZE = 500;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EVENT_DEFINITIONS = Object.freeze({
    AUTH_LOGIN_SUCCEEDED: { severity: 'INFO', category: 'AUTH', message: 'User signed in', outcome: 'SUCCESS' },
    AUTH_LOGIN_FAILED: { severity: 'WARN', category: 'AUTH', message: 'Sign-in failed', outcome: 'FAILURE', metadata: { reason: ['invalid_credentials'] } },
    AUTH_LOGOUT: { severity: 'INFO', category: 'AUTH', message: 'User signed out', outcome: 'SUCCESS' },
    AUTH_ADMIN_ACCESS_DENIED: { severity: 'WARN', category: 'AUTH', message: 'Administrator access denied', outcome: 'DENIED', metadata: { resource: ['system_logs', 'admin_api'], reason: ['unauthenticated', 'not_administrator', 'session_revoked'] } },
    PROVIDER_CONNECTION_TEST_STARTED: { severity: 'INFO', category: 'PROVIDER', message: 'Provider connection test started', outcome: 'UNKNOWN', metadata: { diagnostic: 'boolean' } },
    PROVIDER_CONNECTION_TEST_COMPLETED: { severity: 'INFO', category: 'PROVIDER', message: 'Provider connection test completed', outcome: 'SUCCESS', metadata: { durationMs: 'number', modelCount: 'number' } },
    PROVIDER_CONNECTION_TEST_FAILED: { severity: 'WARN', category: 'PROVIDER', message: 'Provider connection test failed', outcome: 'FAILURE', metadata: { reason: ['provider_unavailable', 'credential_missing', 'invalid_response', 'operation_failed'], durationMs: 'number' } },
    PROVIDER_CONFIGURATION_CHANGED: { severity: 'INFO', category: 'PROVIDER', message: 'Provider configuration changed', outcome: 'SUCCESS', metadata: { providerCount: 'number', enabledCount: 'number', change: ['saved', 'credential_saved', 'credential_removed'] } },
    CONFIG_ADMIN_SETTINGS_UPDATED: { severity: 'INFO', category: 'CONFIG', message: 'Administrator settings updated', outcome: 'SUCCESS', metadata: { changedFields: 'setting_fields' } },
    CONFIG_OPENAI_SAFEGUARDS_CHANGED: { severity: 'INFO', category: 'CONFIG', message: 'OpenAI safeguards changed', outcome: 'SUCCESS', metadata: { enabled: 'boolean', maxOutputTokens: 'number', maxConcurrent: 'number', perHour: 'number', perDay: 'number' } },
    CONFIG_DEEPSEEK_SAFEGUARDS_CHANGED: { severity: 'INFO', category: 'CONFIG', message: 'DeepSeek safeguards changed', outcome: 'SUCCESS', metadata: { enabled: 'boolean', maxOutputTokens: 'number', maxConcurrent: 'number', perHour: 'number', perDay: 'number' } },
    MCP_TOOL_EXECUTION_FAILED: {
        severity: 'WARN', category: 'SYSTEM', message: 'MCP tool execution failed', outcome: 'FAILURE',
        metadata: {
            toolName: 'mcp_tool_name',
            stage: ['argument_parsing', 'policy_validation', 'process_launch', 'connection', 'initialization', 'tools_call', 'result_validation', 'result_serialization'],
            errorCategory: ['invalid_tool_arguments', 'tool_not_authorized', 'policy_rejected', 'process_unavailable', 'mcp_connection_failed', 'mcp_initialization_failed', 'mcp_call_failed', 'invalid_tool_result', 'tool_result_too_large', 'serialization_failed'],
            durationMs: 'number'
        }
    },
    RUNTIME_BACKEND_HEALTH_CHANGED: { severity: 'INFO', category: 'RUNTIME', message: 'Backend health state changed', outcome: 'UNKNOWN', metadata: { previousState: ['ready', 'unavailable', 'unsupported', 'authentication_failed', 'loading_or_unavailable'], currentState: ['ready', 'unavailable', 'unsupported', 'authentication_failed', 'loading_or_unavailable'] } }
});
const SETTING_FIELDS = new Set([
    'model', 'parallel', 'contextSize', 'gpuLayers', 'device', 'splitMode', 'tensorSplit', 'verbosity', 'metrics'
]);

function boundedId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

function sanitizeMetadata(definition, value) {
    if (!definition.metadata || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const [key, rule] of Object.entries(definition.metadata)) {
        const candidate = value[key];
        if (rule === 'boolean' && typeof candidate === 'boolean') result[key] = candidate;
        else if (rule === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 10000000) result[key] = candidate;
        else if (rule === 'mcp_tool_name' && typeof candidate === 'string' &&
            /^[A-Za-z0-9_-]{1,48}__[A-Za-z0-9_-]{1,48}$/.test(candidate)) result[key] = candidate;
        else if (rule === 'setting_fields' && Array.isArray(candidate)) {
            const fields = [...new Set(candidate.filter(field => typeof field === 'string' && SETTING_FIELDS.has(field)))].slice(0, SETTING_FIELDS.size);
            if (fields.length) result[key] = fields;
        } else if (Array.isArray(rule) && rule.includes(candidate)) result[key] = candidate;
    }
    return Object.keys(result).length ? result : null;
}

function parsePageValue(value, fallback, maximum) {
    if (value === null || value === undefined || value === '') return fallback;
    if (!/^\d+$/.test(value)) throw new TypeError('Invalid pagination value');
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new TypeError('Invalid pagination value');
    return number;
}

function parseDate(value, name) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{1,3})?Z)?$/.test(value)) {
        throw new TypeError(`Invalid ${name}`);
    }
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new TypeError(`Invalid ${name}`);
    if (/^\d{4}-\d\d-\d\d$/.test(value) && new Date(time).toISOString().slice(0, 10) !== value) {
        throw new TypeError(`Invalid ${name}`);
    }
    return new Date(time).toISOString();
}

function validateFilters(input = {}) {
    const severity = input.severity || null;
    const category = input.category || null;
    if (severity && !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(severity)) throw new TypeError('Invalid severity');
    if (category && !['AUTH', 'PROVIDER', 'CONFIG', 'RUNTIME', 'SYSTEM'].includes(category)) throw new TypeError('Invalid category');
    const eventCode = input.eventCode || null;
    if (eventCode && (typeof eventCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(eventCode))) throw new TypeError('Invalid event code');
    const providerId = input.providerId || null;
    const correlationId = input.correlationId || null;
    if (providerId && !boundedId(providerId)) throw new TypeError('Invalid provider ID');
    if (correlationId && !boundedId(correlationId)) throw new TypeError('Invalid correlation ID');
    const from = parseDate(input.from, 'start date');
    const to = parseDate(input.to, 'end date');
    if (from && to && from > to) throw new TypeError('Invalid date range');
    return {
        severity, category, eventCode, providerId, correlationId, from, to,
        page: parsePageValue(input.page, 1, DEFAULT_MAX_EVENTS + 1),
        pageSize: parsePageValue(input.pageSize, 50, MAX_PAGE_SIZE)
    };
}

function createSystemLogService({
    db,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    maxEvents = DEFAULT_MAX_EVENTS,
    now = Date.now,
    createId = randomUUID,
    setImmediateFn = setImmediate
}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('SQLite database is required');
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || !Number.isSafeInteger(maxEvents) || maxEvents < 1) {
        throw new TypeError('Valid retention limits are required');
    }
    let queue = [];
    let scheduled = false;
    let running = null;
    let closed = false;
    let dropped = 0;
    let failures = 0;
    let timer = null;

    function prune() {
        const cutoff = new Date(now() - maxAgeMs).toISOString();
        db.prepare(`DELETE FROM system_events WHERE event_id IN (
            SELECT event_id FROM system_events WHERE occurred_at < ?
            ORDER BY occurred_at ASC, event_id ASC LIMIT ?
        )`).run(cutoff, PRUNE_BATCH_SIZE);
        db.prepare(`DELETE FROM system_events WHERE event_id IN (
            SELECT event_id FROM system_events
            ORDER BY occurred_at DESC, event_id DESC LIMIT ? OFFSET ?
        )`).run(PRUNE_BATCH_SIZE, maxEvents);
    }

    function write(event) {
        db.prepare(`INSERT INTO system_events (
            event_id, occurred_at, severity, category, event_code, message,
            metadata_json, correlation_id, actor_id, provider_id, outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            event.eventId, event.timestamp, event.severity, event.category,
            event.eventCode, event.message, event.metadata ? JSON.stringify(event.metadata) : null,
            event.correlationId, event.actorId, event.providerId, event.outcome
        );
    }

    function drain() {
        scheduled = false;
        if (closed || running) return running;
        running = Promise.resolve().then(() => {
            const batch = queue.splice(0, 100);
            for (const event of batch) {
                try { write(event); } catch { failures++; }
            }
            try { prune(); } catch { failures++; }
        }).finally(() => {
            running = null;
            if (queue.length) schedule();
        });
        return running;
    }

    function schedule() {
        if (closed || scheduled || running) return;
        scheduled = true;
        setImmediateFn(() => { void drain(); });
    }

    function log(eventCode, fields = {}) {
        try {
            const definition = EVENT_DEFINITIONS[eventCode];
            if (!definition || closed) return false;
            if (queue.length >= MAX_QUEUE_SIZE) { dropped++; return false; }
            const severity = eventCode === 'RUNTIME_BACKEND_HEALTH_CHANGED' && fields.metadata?.currentState !== 'ready'
                ? 'WARN' : definition.severity;
            const outcome = eventCode === 'RUNTIME_BACKEND_HEALTH_CHANGED'
                ? (fields.metadata?.currentState === 'ready' ? 'SUCCESS' : 'FAILURE')
                : definition.outcome;
            const timestampMs = now();
            const eventId = boundedId(createId());
            if (!eventId) return false;
            queue.push({
                eventId,
                timestamp: new Date(timestampMs).toISOString(),
                severity,
                category: definition.category,
                eventCode,
                message: definition.message,
                metadata: sanitizeMetadata(definition, fields.metadata),
                correlationId: boundedId(fields.correlationId),
                actorId: boundedId(fields.actorId),
                providerId: boundedId(fields.providerId),
                outcome
            });
            schedule();
            return true;
        } catch {
            failures++;
            return false;
        }
    }

    async function flush() {
        while (queue.length || running || scheduled) {
            if (scheduled && !running) await drain();
            else if (running) await running;
        }
    }

    function list(rawFilters = {}) {
        const filters = validateFilters(rawFilters);
        const clauses = [];
        const values = [];
        for (const [key, column] of [
            ['severity', 'severity'], ['category', 'category'], ['eventCode', 'event_code'],
            ['providerId', 'provider_id'], ['correlationId', 'correlation_id']
        ]) {
            if (filters[key]) { clauses.push(`${column} = ?`); values.push(filters[key]); }
        }
        if (filters.from) { clauses.push('occurred_at >= ?'); values.push(filters.from); }
        if (filters.to) { clauses.push('occurred_at <= ?'); values.push(filters.to); }
        clauses.push('occurred_at >= ?');
        values.push(new Date(now() - maxAgeMs).toISOString());
        const where = clauses.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS count FROM system_events WHERE ${where}`).get(...values).count;
        const events = db.prepare(`SELECT event_id, occurred_at, severity, category, event_code, message,
            metadata_json, correlation_id, actor_id, provider_id, outcome
            FROM system_events WHERE ${where}
            ORDER BY occurred_at DESC, event_id DESC LIMIT ? OFFSET ?`)
            .all(...values, filters.pageSize, (filters.page - 1) * filters.pageSize)
            .map(row => {
                let metadata = null;
                try {
                    const parsed = row.metadata_json ? JSON.parse(row.metadata_json) : null;
                    metadata = sanitizeMetadata(EVENT_DEFINITIONS[row.event_code], parsed);
                } catch { /* Invalid metadata is not exposed. */ }
                return {
                    eventId: row.event_id,
                    timestamp: row.occurred_at,
                    severity: row.severity,
                    category: row.category,
                    eventCode: row.event_code,
                    message: row.message,
                    metadata,
                    correlationId: boundedId(row.correlation_id),
                    actorId: boundedId(row.actor_id),
                    providerId: boundedId(row.provider_id),
                    outcome: row.outcome
                };
            });
        return { events, page: filters.page, pageSize: filters.pageSize, total };
    }

    function startRetention(intervalMs = 60000) {
        if (timer || closed) return;
        try { prune(); } catch { failures++; }
        try {
            timer = setInterval(() => {
                try { prune(); } catch { failures++; }
            }, intervalMs);
            timer.unref?.();
        } catch { failures++; }
    }

    function stop() {
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
        queue = [];
    }

    return Object.freeze({
        log, list, flush, prune, startRetention, stop,
        getStats: () => ({ queued: queue.length, dropped, failures })
    });
}

module.exports = {
    createSystemLogService,
    validateFilters,
    EVENT_DEFINITIONS,
    DEFAULT_MAX_AGE_MS,
    DEFAULT_MAX_EVENTS,
    MAX_PAGE_SIZE
};
