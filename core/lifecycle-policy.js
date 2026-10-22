"use strict";

// Simulation successor to chatbot-lifecycle.ps1's TEST provider contract.
// No production adapter or I/O. Effects describe simulations, never OS authority.
const DEFAULTS = Object.freeze({ startupMs: 300000, shutdownMs: 10000,
    healthFailures: 3, recoveryLaunches: 3, recoveryWindowMs: 900000,
    backoffMs: Object.freeze([5000, 15000, 60000]), autoRecovery: false,
    maxObservationAgeMs: 2000 });
const TRANSITIONS = Object.freeze({
    stopped: ['starting', 'failed', 'blocked'], starting: ['ready', 'failed', 'blocked', 'stopping'],
    ready: ['degraded', 'stopping', 'stopped', 'failed', 'blocked'],
    degraded: ['ready', 'stopping', 'stopped', 'failed', 'blocked'],
    stopping: ['stopped', 'failed', 'blocked'], backoff: ['starting', 'stopped', 'blocked', 'failed'],
    failed: ['starting', 'stopping', 'stopped', 'backoff', 'blocked'], blocked: []
});

function createTestLifecyclePolicy({ mode, now, policy = {} } = {}) {
    if (mode !== 'TEST' || typeof now !== 'function') throw new Error('TEST clock provider required');
    if (Object.keys(policy).some(k => !(k in DEFAULTS))) throw new Error('Unknown policy option');
    const p = { ...DEFAULTS, ...policy, backoffMs: [...(policy.backoffMs || DEFAULTS.backoffMs)] };
    for (const k of ['startupMs','shutdownMs','healthFailures','recoveryLaunches','recoveryWindowMs','maxObservationAgeMs']) {
        if (!Number.isSafeInteger(p[k]) || p[k] <= 0) throw new Error('Invalid policy value');
    }
    if (typeof p.autoRecovery !== 'boolean' || !p.backoffMs.length ||
        p.backoffMs.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('Invalid recovery policy');
    let state = 'stopped', operation = null, serial = 0, handle = null, unresolved = false;
    let suppressed = false, failures = 0, launches = [], due = null, lastTime = -1, lastSequence = -1;
    let reason = 'initialized', outcome = 'stopped', shutdown = null, lastOperation = null, effectAt = -1;
    const move = next => {
        if (next !== state && !TRANSITIONS[state].includes(next)) throw new Error('Illegal transition');
        state = next;
    };
    const result = effects => ({ schemaVersion: 1, mode: 'TEST', state, outcome, reason,
        operationId: operation?.id ?? lastOperation?.id ?? null, operationType: operation?.type ?? lastOperation?.type ?? null,
        diagnostics: { owned: handle !== null, unresolvedLaunch: unresolved,
            consecutiveHealthFailures: failures, recoverySuppressed: suppressed,
            recoveryLaunches: launches.length, backoffUntil: due, shutdown,
            deadline: operation?.deadline ?? null,
            forcedStopEligible: state === 'failed' && shutdown === 'incomplete' && handle !== null },
        effects: effects.map(type => ({ type, operationId: operation?.id ?? null, simulationOnly: true })) });
    const block = why => { move('blocked'); reason = why; outcome = 'blocked'; due = null; };
    function evidence(o, time) {
        if (!o || o.complete !== true || o.stable !== true || !Number.isSafeInteger(o.sequence) ||
            o.sequence <= lastSequence || !Number.isFinite(o.observedAt) || o.observedAt > time ||
            o.observedAt < effectAt || time - o.observedAt > p.maxObservationAgeMs ||
            !['absent','alive','exited'].includes(o.process) || !['absent','owned','foreign'].includes(o.listener)) {
            block('observation-unverifiable'); return false;
        }
        lastSequence = o.sequence;
        if (o.listener === 'foreign') { block('foreign-listener'); return false; }
        if (handle !== null && (o.retainedHandle !== handle || o.identityVerified !== true)) {
            block('ownership-lost'); return false;
        }
        if (!handle && o.process !== 'absent') { block('unowned-process'); return false; }
        if (o.listener === 'owned' && (!handle || o.process !== 'alive')) {
            block('listener-identity-conflict'); return false;
        }
        return true;
    }
    function absent(o) { return ['absent','exited'].includes(o.process) && o.listener === 'absent'; }
    function begin(type, time) {
        operation = { id: `test-operation-${++serial}`, type, deadline: null };
        lastOperation = {id:operation.id,type};
        reason = 'operation-accepted'; outcome = 'in-progress'; shutdown = null;
    }
    function launch(time, effects, recovery = false) {
        if (recovery) {
            launches = launches.filter(t => time - t < p.recoveryWindowMs);
            if (launches.length >= p.recoveryLaunches) { move('failed'); outcome='failed'; reason='recovery-budget-exhausted'; operation=null; due=null; return; }
            launches.push(time);
        }
        move('starting'); operation.deadline = time + p.startupMs; unresolved = true;
        due = null; failures = 0; effectAt=time; effects.push('simulate-launch');
    }
    function schedule(time) {
        operation = null;
        if (!p.autoRecovery || suppressed) return;
        launches = launches.filter(t => time - t < p.recoveryWindowMs);
        if (launches.length >= p.recoveryLaunches) { reason='recovery-budget-exhausted'; return; }
        move('backoff'); due = time + p.backoffMs[Math.min(launches.length, p.backoffMs.length-1)];
        reason='recovery-backoff'; outcome='waiting';
    }
    function stop(time, effects) {
        move('stopping'); operation.deadline=time+p.shutdownMs;
        shutdown='clean-requested'; effectAt=time; effects.push('simulate-clean-stop');
    }
    function dispatch(event, observation) {
        const effects=[];
        let time;
        try { time=now(); } catch { block('clock-unverifiable'); return result(effects); }
        if (!Number.isSafeInteger(time) || time < 0 || time < lastTime) { block('clock-unverifiable'); return result(effects); }
        lastTime=time;
        if (!event || !['start','stop','restart','observe','tick','launched','cancel','force-stop'].includes(event.type)) {
            return { ...result([]), outcome:'rejected', reason:'invalid-event' };
        }
        if (state === 'blocked') return result([]);
        const request=['start','stop','restart'].includes(event.type);
        if (request && operation) return { ...result([]), outcome:'busy', reason:'operation-in-progress' };
        if (request && state==='backoff' && event.type!=='stop') return { ...result([]), outcome:'busy', reason:'recovery-pending' };
        if (event.type==='cancel') {
            if (!operation || event.operationId!==operation.id) return { ...result([]),outcome:'rejected',reason:'stale-operation' };
            suppressed=true; outcome='cancelled'; reason='operation-cancelled';
            if (unresolved || state==='stopping') { block('cancelled-operation-unresolved'); return result([]); }
            if (handle) { move('failed'); operation=null; } else { move('stopped'); operation=null; }
            return result([]);
        }
        if (event.type==='launched') {
            if (!operation || event.operationId!==operation.id || state!=='starting' || !unresolved) {
                return { ...result([]),outcome:'rejected',reason:'stale-operation' };
            }
            // Token must be returned by the simulated launch, not reconstructed from a PID.
            if (!event.retainedHandle || typeof event.retainedHandle !== 'object' || event.identityVerified !== true) {
                block('launch-handle-unverifiable'); return result([]);
            }
            handle=event.retainedHandle; unresolved=false;
            if(time>=operation.deadline){move('failed');reason='startup-timeout';outcome='failed';operation=null;}
            return result([]);
        }
        if (!evidence(observation,time)) return result([]);
        const o=observation;
        if (['authentication','configuration','security'].includes(o.failure)) {
            block(o.failure+'-failure');return result([]);
        }
        if (request) {
            if(unresolved){block('previous-launch-unresolved');return result([]);}
            suppressed = event.type === 'stop';
            begin(event.type,time);
            if(absent(o)) {
                handle=null;
                if(event.type==='stop'){move('stopped');due=null;operation=null;outcome='stopped';reason='verified-absent';}
                else {suppressed=false;if(state==='ready'||state==='degraded')move('stopped');launch(time,effects);}
            } else if(handle && o.process==='alive') {
                if(event.type==='start'){operation=null;outcome='already-running';reason='owned-process-present';}
                else stop(time,effects);
            } else block('runtime-unverifiable');
            return result(effects);
        }
        if(event.type==='force-stop') {
            if(!operation || event.operationId!==operation.id || state!=='failed' || shutdown!=='incomplete' ||
                !handle || o.process!=='alive' || event.approved!==true) return {...result([]),outcome:'rejected',reason:'force-stop-not-authorized'};
            move('stopping');operation.deadline=time+p.shutdownMs;shutdown='forced-requested';effectAt=time;effects.push('simulate-force-stop');return result(effects);
        }
        if(state==='backoff') {
            if(!absent(o)){block('recovery-runtime-conflict');return result([]);}
            if(time>=due){begin('recovery',time);launch(time,effects,true);}
            return result(effects);
        }
        if(state==='starting') {
            if(time>=operation.deadline){move('failed');outcome='failed';reason='startup-timeout';
                if(unresolved)block('startup-timeout-unresolved');else operation=null;return result([]);}
            if(unresolved) return result([]);
            if(absent(o)){handle=null;move('failed');reason='process-exited';outcome='failed';schedule(time);return result([]);}
            if(['authentication','configuration','security'].includes(o.failure)){block(o.failure+'-failure');return result([]);}
            if(o.listener==='owned' && o.health==='ok'){move('ready');outcome='ready';reason='verified-ready';operation=null;}
            return result([]);
        }
        if(state==='stopping') {
            if(absent(o)) {
                handle=null;move('stopped');shutdown=shutdown==='forced-requested'?'forced-complete':'clean-complete';
                const type=operation.type;operation=null;outcome='stopped';reason='termination-and-release-verified';
                if(type==='restart'){begin('restart',time);launch(time,effects);}
                else if(type==='recovery'){move('failed');schedule(time);}
            } else if(time>=operation.deadline){move('failed');shutdown='incomplete';reason='shutdown-timeout';outcome='failed';}
            return result(effects);
        }
        if(state==='ready'||state==='degraded') {
            if(absent(o)){handle=null;move('failed');reason='process-exited';outcome='failed';schedule(time);return result([]);}
            if(['authentication','configuration','security'].includes(o.failure)){block(o.failure+'-failure');return result([]);}
            if(!['ok','retryable-failure'].includes(o.health)){block('health-unverifiable');return result([]);}
            if(o.health==='ok' && o.listener==='owned'){failures=0;move('ready');outcome='ready';reason='verified-ready';}
            else {failures++;move('degraded');outcome='degraded';reason='health-failure';
                if(failures>=p.healthFailures){
                    if(p.autoRecovery&&!suppressed){begin('recovery',time);stop(time,effects);}
                    else {move('failed');outcome='failed';reason='health-threshold';}
                }
            }
        }
        return result(effects);
    }
    return Object.freeze({dispatch, snapshot:()=>result([])});
}

module.exports = { createTestLifecyclePolicy, DEFAULTS, TRANSITIONS };
