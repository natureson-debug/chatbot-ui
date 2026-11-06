'use strict';
// Server-only contract. No default backend, storage, environment reads or logging.
const STATES = Object.freeze({
    available: 'CREDENTIAL_AVAILABLE', missing: 'CREDENTIAL_MISSING',
    inaccessible: 'CREDENTIAL_INACCESSIBLE', undecryptable: 'CREDENTIAL_UNDECRYPTABLE',
    unsupported: 'CREDENTIAL_UNSUPPORTED_PLATFORM', invalid: 'CREDENTIAL_INVALID_REFERENCE',
    denied: 'CREDENTIAL_ACCESS_DENIED', invalidSecret: 'CREDENTIAL_INVALID_SECRET',
    failure: 'CREDENTIAL_BACKEND_FAILURE', removed: 'CREDENTIAL_REMOVED'
});
const result = state => Object.freeze({ status: state, code: STATES[state] });
const validSecret = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !/[\r\n\x00]/.test(value);
function descriptor(reference, context) {
    if (typeof reference !== 'string' || !context || context.credentialRef !== reference) return null;
    if (/^env:CHATBOT_[A-Z0-9_]{1,80}$/.test(reference)) return Object.freeze({ source: 'environment', reference });
    if (reference === 'protected:brave-search' && context.provider === 'brave-search')
        return Object.freeze({ source: 'protected', reference, binding: JSON.stringify(['chatbot-brave-search-v1']) });
    if (context.adapter === 'deepseek-chat' && /^[a-z][a-z0-9-]{0,47}$/.test(context.id) && reference === 'protected:' + context.id) {
        const endpoint = new URL(context.endpoint);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
        return Object.freeze({ source: 'protected', reference, binding: JSON.stringify(['chatbot-deepseek-v1', context.id, endpoint.href]) });
    }
    if (reference === 'local-api-key' && context.adapter === 'llama.cpp' && new URL(context.endpoint).origin === 'http://127.0.0.1:8080')
        return Object.freeze({ source: 'legacyLocal', reference });
    return null;
}
function createCredentialService({ backends = {}, authorize = () => false } = {}) {
    const sources = Object.freeze({ ...backends });
    async function operation(action, reference, secret, context) {
        let target;
        try { target = descriptor(reference, context); } catch { return result('invalid'); }
        if (!target) return result('invalid');
        // Snapshot binding before any await; never accept a boolean from the caller
        // as authorization. authorize is installed by trusted server composition.
        const allowed = async () => { try { return await authorize(action, target, context) === true; } catch { return false; } };
        if (!await allowed()) return result('denied');
        if (action === 'replace' && !validSecret(secret)) return result('invalidSecret');
        const backend = sources[target.source];
        if (!backend || typeof backend[action] !== 'function') return result('unsupported');
        try {
            // A real write backend must call this guard immediately before commit.
            const response = await backend[action](target, action === 'replace' ? secret.trim() : undefined, { authorize: allowed });
            if (!await allowed()) return result('denied');
            if (!response || !['available', 'missing', 'inaccessible', 'undecryptable', 'unsupported', 'removed'].includes(response.status)) return result('failure');
            if (action === 'remove') return ['missing', 'removed'].includes(response.status) ? result('removed') : result(response.status === 'available' ? 'failure' : response.status);
            if (response.status === 'removed') return result('failure');
            if (action === 'resolve' && response.status === 'available') {
                if (!validSecret(response.secret)) return result('failure');
                return Object.freeze({ ...result('available'), secret: response.secret });
            }
            // Never spread backend metadata, error messages or incidental secrets.
            return result(response.status);
        } catch { return result('failure'); }
    }
    return Object.freeze({
        status: (reference, context) => operation('status', reference, undefined, context),
        resolve: (reference, context) => operation('resolve', reference, undefined, context),
        replace: (reference, secret, context) => operation('replace', reference, secret, context),
        remove: (reference, context) => operation('remove', reference, undefined, context)
    });
}
module.exports = { createCredentialService, STATES };
