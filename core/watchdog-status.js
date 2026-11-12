'use strict';
const { execFile } = require('node:child_process');
const path = require('node:path');
const states = ['healthy','starting','unhealthy','absent','uncertain'];
const reasons = ['lock-unavailable','absence-not-stable','recovery-latched','recovery-timeout','recovery-verified','recovery-not-verified','observation-or-recovery-failed','backend-task-disabled','task-starting','verified-absence','task-state-unverified','listener-not-ready','process-or-listener-unverified','ownership-or-configuration-unverified','evidence-changed','evidence-unavailable','health-healthy','health-starting','health-unhealthy','health-uncertain'];
const taskReasons = ['task-access-denied','task-not-found','task-unavailable'];
const backendReasons = ['evidence-unavailable','ownership-unverified','ownership-changed','configuration-changed'];
function normalize(raw, now) {
    const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const task = raw?.task;
    const backend = raw?.backend;
    const log = raw?.log;
    const updatedAt = date(log?.updatedAt);
    const observations = Array.isArray(log?.observations) ? log.observations.slice(-12).filter(o => states.includes(o?.state) && reasons.includes(o?.reason) && typeof o.recoveryAttempted === 'boolean').map(o => ({state:o.state,reason:o.reason,recoveryAttempted:o.recoveryAttempted})) : [];
    const taskValid = task && ['Disabled','Ready','Running','Queued','Unknown'].includes(task.state) && typeof task.enabled === 'boolean' && Number.isSafeInteger(task.lastResult);
    const backendVerified = backend?.verified === true && Number.isSafeInteger(backend.pid) && backend.pid>0 &&
        ((backend.reason === 'verified' && backend.configurationMatched === true) ||
         (backend.reason === 'configuration-mismatch' && backend.configurationMatched === false));
    return {
        sampledAt:new Date(now).toISOString(), pollIntervalMs:15000,
        task:taskValid ? {state:task.state,enabled:task.enabled,lastRun:date(task.lastRun),nextRun:date(task.nextRun),lastResult:task.lastResult} : null,
        taskReason:taskValid ? null : taskReasons.includes(raw?.taskReason) ? raw.taskReason : 'task-unavailable',
        backend:backend ? backendVerified
            ? {verified:true,configurationMatched:backend.configurationMatched,pid:backend.pid,reason:backend.reason}
            : {verified:null,configurationMatched:null,pid:null,reason:backendReasons.includes(backend.reason) ? backend.reason : 'evidence-unavailable'} : null,
        observedListenerPid:Number.isSafeInteger(raw?.observedListenerPid) && raw.observedListenerPid>0 ? raw.observedListenerPid : null,
        marker:['present','absent'].includes(raw?.marker) ? raw.marker : 'unavailable',
        log:log && updatedAt ? {updatedAt,stale:now-Date.parse(updatedAt)>300000 || Date.parse(updatedAt)>now+5000,observations,malformed:log.malformed!==false || observations.length!==(log.observations?.length ?? 0)} : null
    };
}
function collectWindows() {
    return new Promise((resolve,reject) => execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-watchdog-status.ps1')],
        {shell:false,windowsHide:true,timeout:8000,maxBuffer:32768,encoding:'utf8'},
        (error,stdout) => { if(error) return reject(Error('STATUS_UNAVAILABLE')); try {resolve(JSON.parse(stdout));} catch {reject(Error('STATUS_MALFORMED'));} }));
}
function createWatchdogStatus({platform=process.platform,collect=collectWindows,now=Date.now}={}) {
    let cached, pending, completed=-Infinity;
    return async () => {
        if(cached && now()-completed<15000) return cached;
        if(pending) return pending;
        pending=(async()=>{
            if(platform!=='win32') return {...normalize(null,now()),availability:'unsupported'};
            try {const raw=await collect();return {...normalize(raw,now()),availability:raw && typeof raw==='object' ? 'observed' : 'unavailable'};}
            catch {return {...normalize(null,now()),availability:'unavailable'};}
        })().then(value=>{cached=value;completed=now();return value;}).finally(()=>{pending=null;});
        return pending;
    };
}
const getWatchdogStatus=createWatchdogStatus();
module.exports={getWatchdogStatus,createWatchdogStatus,normalize};
