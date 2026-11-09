'use strict';

const STATES = Object.freeze({
    stopped: 'stopped',
    starting: 'starting',
    ready: 'ready',
    stopping: 'stopping',
    ownershipUncertain: 'ownership-uncertain',
    failed: 'failed'
});

function evidenceError(code, reason) {
    return Object.freeze({ status: STATES.failed, code, reason });
}

function validateObservation(observation) {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return false;
    if (observation.state === 'absent') return true;
    if (observation.state !== 'verified') return false;
    return Number.isInteger(observation.pid) && observation.pid > 0 &&
        typeof observation.createdAt === 'string' && observation.createdAt.length > 0 &&
        observation.listener && Number.isInteger(observation.listener.owningPid) &&
        observation.listener.owningPid === observation.pid;
}

function createWindowsBackendLifecycle({
    observe,
    assess = null,
    effects = {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
    readinessTimeoutMs = 5000
} = {}) {
    if (typeof observe !== 'function' || !effects || typeof effects.launch !== 'function' ||
        typeof effects.stop !== 'function') {
        throw new TypeError('observe(), effects.launch() and effects.stop() are required');
    }

    let state = STATES.stopped;
    let operation = null;
    let lastEvidence = null;
    let nextOperationId = 0;

    const outcome = (status, reason, extra = {}) => Object.freeze({
        status, operationId: operation?.id ?? null, reason, state, evidence: lastEvidence, ...extra
    });

    async function withLock(action) {
        if (operation) return outcome(STATES.failed, 'operation-in-progress', { code: 'BUSY' });
        const id = ++nextOperationId;
        operation = { id, type: action };
        try {
            return await action(id);
        } finally {
            operation = null;
        }
    }

    async function reobserve(expectedObservation) {
        const current = await observe();
        lastEvidence = current;
        if (!validateObservation(current)) return { ok: false, code: 'EVIDENCE_INSUFFICIENT' };
        if (expectedObservation?.state === 'verified') {
            if (current.state !== 'verified') return { ok: false, code: 'OWNERSHIP_CHANGED' };
            if (expectedObservation.pid !== undefined && current.pid !== expectedObservation.pid) return { ok: false, code: 'OWNERSHIP_CHANGED' };
            if (expectedObservation.createdAt !== undefined && current.createdAt !== expectedObservation.createdAt) return { ok: false, code: 'OWNERSHIP_CHANGED' };
        } else if (expectedObservation?.state === 'absent' && current.state !== 'absent') {
            return { ok: false, code: 'OWNERSHIP_CHANGED' };
        }
        return { ok: true, observation: current };
    }

    async function verifyReadiness() {
        const started = now();
        while (true) {
            const check = await reobserve(null);
            if (!check.ok) return { ok: false, code: check.code };
            if (check.observation.state === 'verified') return { ok: true, observation: check.observation };
            if (now() - started >= readinessTimeoutMs) return { ok: false, code: 'READINESS_TIMEOUT' };
            await new Promise(resolve => setTimer(resolve, 10));
        }
    }

    async function proven(observation) {
        if (typeof assess !== 'function') return { ok: true };
        const assessment = await assess();
        if (!assessment || !['eligible', 'absent'].includes(assessment.state)) {
            return { ok: false, code: 'PROVENANCE_REJECTED', assessment };
        }
        return { ok: true, assessment };
    }

    async function start() {
        return withLock(async () => {
            if (state !== STATES.stopped) return outcome(STATES.failed, 'already-running-or-pending', { code: 'INVALID_STATE' });
            const initial = await reobserve({ state: 'absent' });
            if (!initial.ok) return outcome(STATES.ownershipUncertain, initial.code, { code: initial.code });
            const provenance = await proven(initial.observation);
            if (!provenance.ok) return outcome(STATES.ownershipUncertain, 'provenance-not-eligible', { code: provenance.code });
            const beforeLaunch = await reobserve({ state: 'absent' });
            if (!beforeLaunch.ok) return outcome(STATES.ownershipUncertain, beforeLaunch.code, { code: beforeLaunch.code });
            state = STATES.starting;
            await effects.launch({ operationId: operation.id, observation: beforeLaunch.observation, assessment: provenance.assessment });
            const ready = await verifyReadiness();
            if (!ready.ok) { state = STATES.failed; return outcome(STATES.failed, 'readiness-not-verified', { code: ready.code }); }
            state = STATES.ready;
            lastEvidence = ready.observation;
            return outcome(STATES.ready, 'verified-start');
        });
    }

    async function stop() {
        return withLock(async () => {
            if (state !== STATES.ready) return outcome(STATES.failed, 'not-owned-or-running', { code: 'INVALID_STATE' });
            const initial = await reobserve();
            if (!initial.ok || initial.observation.state !== 'verified') return outcome(STATES.ownershipUncertain, 'owned-process-unverified', { code: initial.code || 'EVIDENCE_INSUFFICIENT' });
            const provenance = await proven(initial.observation);
            if (!provenance.ok) return outcome(STATES.ownershipUncertain, 'provenance-not-eligible', { code: provenance.code });
            const beforeStop = await reobserve();
            if (!beforeStop.ok || beforeStop.observation.pid !== initial.observation.pid) {
                return outcome(STATES.ownershipUncertain, 'ownership-changed-before-effect', { code: 'OWNERSHIP_CHANGED' });
            }
            state = STATES.stopping;
            await effects.stop({ operationId: operation.id, observation: beforeStop.observation, assessment: provenance.assessment });
            const afterStop = await reobserve({ state: 'absent' });
            if (!afterStop.ok) { state = STATES.failed; return outcome(STATES.failed, 'termination-not-verified', { code: afterStop.code }); }
            state = STATES.stopped;
            return outcome(STATES.stopped, 'verified-stop');
        });
    }

    async function restart() {
        return withLock(async () => {
            if (state !== STATES.ready) return outcome(STATES.failed, 'not-owned-or-running', { code: 'INVALID_STATE' });
            const initial = await reobserve();
            if (!initial.ok || initial.observation.state !== 'verified') return outcome(STATES.ownershipUncertain, 'owned-process-unverified', { code: initial.code || 'EVIDENCE_INSUFFICIENT' });
            const provenance = await proven(initial.observation);
            if (!provenance.ok) return outcome(STATES.ownershipUncertain, 'provenance-not-eligible', { code: provenance.code });
            const beforeStop = await reobserve();
            if (!beforeStop.ok || beforeStop.observation.pid !== initial.observation.pid) {
                return outcome(STATES.ownershipUncertain, 'ownership-changed-before-effect', { code: 'OWNERSHIP_CHANGED' });
            }
            state = STATES.stopping;
            await effects.stop({ operationId: operation.id, observation: beforeStop.observation, assessment: provenance.assessment });
            const absent = await reobserve({ state: 'absent' });
            if (!absent.ok) { state = STATES.failed; return outcome(STATES.failed, 'termination-not-verified', { code: absent.code }); }
            const beforeLaunch = await reobserve({ state: 'absent' });
            if (!beforeLaunch.ok) return outcome(STATES.failed, beforeLaunch.code, { code: beforeLaunch.code });
            state = STATES.starting;
            await effects.launch({ operationId: operation.id, observation: beforeLaunch.observation, assessment: provenance.assessment });
            const ready = await verifyReadiness();
            if (!ready.ok) { state = STATES.failed; return outcome(STATES.failed, 'readiness-not-verified', { code: ready.code }); }
            state = STATES.ready;
            lastEvidence = ready.observation;
            return outcome(STATES.ready, 'verified-restart');
        });
    }

    function getState() {
        return state;
    }

    return Object.freeze({ start, stop, restart, getState, STATES });
}

module.exports = { createWindowsBackendLifecycle, STATES };
