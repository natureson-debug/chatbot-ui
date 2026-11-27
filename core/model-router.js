'use strict';

const registry = require('./chat-models');
const metadata = require('./model-capabilities');
const TASKS = Object.freeze(['text', 'vision', 'documents', 'coding', 'tools']);
const ADAPTERS = new Set(['llama.cpp', 'ollama', 'openai-compatible', 'openai-responses', 'deepseek-chat']);
const same = (a, b) => a?.providerId === b?.providerId && a?.model === b?.model;
const identity = value => value && typeof value.providerId === 'string' && typeof value.model === 'string'
    ? { providerId: value.providerId, model: value.model } : null;

// Caller supplies structured task intent, not model names or an LLM classifier.
function classify(request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
    if (request.task !== undefined && !TASKS.includes(request.task)) return null;
    if (request.hasImage === true) return 'vision';
    if (request.hasDocuments === true) return 'documents';
    if (request.useTools === true) return 'tools';
    return request.task || 'text';
}

// Evidence/authorization callbacks are trusted SERVER inputs, never request JSON.
// No IO, discovery, inference, persistence or automatic selection integration.
function decide({ config, legacy = null, defaultModel = null, request = {}, priorities = {},
    authorize = () => false, availability = () => null, costPolicy = () => 'unknown',
    approvePaid = () => false, documentPipeline = () => false,
    capabilities = (c, m) => metadata.cachedCapabilities(c, m, Date.now(), true),
    now = Date.now() } = {}) {
    const task = classify(request);
    const required = ['text'];
    if (task === 'vision' || request?.hasImage === true) required.push('vision');
    if (task === 'documents' || request?.hasDocuments === true) required.push('documents');
    if (task === 'tools' || request?.useTools === true) required.push('tools');
    const result = { requestedTask: task, requiredCapabilities: required, selected: null,
        conversationDefault: identity(defaultModel), fallbackUsed: false, reason: 'no-eligible-model',
        eligibility: 'ineligible', candidates: [] };
    if (!task || !config || !Array.isArray(config.connections) || !Number.isFinite(now) || !priorities || typeof priorities !== 'object' || Array.isArray(priorities)) {
        return { ...result, reason: 'invalid-routing-input' };
    }
    const preferred = priorities[task] ?? [];
    if (!Array.isArray(preferred) || preferred.length > 100 || preferred.some(p => !identity(p))) {
        return { ...result, reason: 'invalid-priorities' };
    }
    // General text keeps the conversation default first. Other tasks use explicit order.
    const ordered = task === 'text' ? [defaultModel, ...preferred] : [...preferred, defaultModel];
    const candidates = ordered.filter(identity).filter((p, i, a) => a.findIndex(v => same(v, p)) === i);
    const fresh = (at, ttl) => Number.isFinite(Date.parse(at)) && now >= Date.parse(at) && now - Date.parse(at) < ttl;
    for (const candidate of candidates) {
        const pair = identity(candidate);
        let reason = null;
        try {
            const selected = registry.resolve(config, pair, legacy);
            const base = pair.providerId === 'legacy-local' ? legacy : config.connections.find(c => c.id === pair.providerId);
            if (!ADAPTERS.has(selected.adapter)) reason = 'adapter-unsupported';
            else if (authorize(pair, selected) !== true) reason = 'not-authorized';
            else {
                const cost = costPolicy(pair, selected);
                const knownCloud = ['openai-responses', 'deepseek-chat'].includes(selected.adapter);
                if ((knownCloud || cost !== 'free') && approvePaid(pair, selected) !== true) reason = 'paid-authorization-required';
                const health = availability(pair, selected);
                if (!reason && (!same(health, pair) || health?.state !== 'available' || !fresh(health.checkedAt, 30000))) reason = 'provider-unavailable-or-unverified';
                const profile = capabilities(base, pair.model);
                if (!reason && (!same(profile, pair) || !fresh(profile?.checkedAt, 300000))) reason = 'capabilities-stale-or-missing';
                if (!reason) for (const capability of required) {
                    const entry = profile.capabilities?.[capability];
                    if (entry?.state !== 'verified') { reason = capability + (entry?.state === 'unsupported' ? '-unsupported' : '-unknown'); break; }
                    if (capability === 'documents') {
                        if (entry.scope !== 'application' || documentPipeline(pair, selected) !== true) { reason = 'document-pipeline-unavailable'; break; }
                    } else if (entry.scope !== 'native') { reason = capability + '-unverified-scope'; break; }
                }
                if (!reason && required.includes('vision') && selected.adapter !== 'ollama') reason = 'image-adapter-unsupported';
                if (!reason && required.includes('tools') && (!['ollama', 'openai-compatible'].includes(selected.adapter) || selected.capabilities.tools !== true)) reason = 'tool-adapter-unsupported';
                if (!reason && required.includes('vision') && required.includes('tools')) reason = 'image-tools-not-qualified';
            }
        } catch { reason = 'selection-or-evidence-unavailable'; }
        result.candidates.push({ ...pair, reason: reason || 'eligible' });
        if (!reason) return { ...result, selected: pair, eligibility: 'eligible',
            fallbackUsed: result.candidates.length > 1,
            reason: task === 'text' && same(pair, defaultModel) ? 'conversation-default-eligible' : 'first-eligible-preference' };
    }
    return result;
}

module.exports = { classify, decide, TASKS };
