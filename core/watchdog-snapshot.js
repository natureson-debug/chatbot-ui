'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { normalize } = require('./watchdog-status');

const MAX_BYTES = 16384;
const MAX_AGE_MS = 120000;
const FUTURE_SKEW_MS = 5000;
const SYSTEM_SID = 'S-1-5-18';
const taskReasons = ['task-access-denied','task-not-found','task-unavailable'];
const backendReasons = ['evidence-unavailable','ownership-unverified','ownership-changed','configuration-changed'];
const taskStates = ['Disabled','Ready','Running','Queued','Unknown'];
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value,k));
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nullableDate = value => value === null || iso(value);
const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;

function validatePayload(p) {
    if (!keys(p,['schemaVersion','collectedAt','producer','task','taskReason','backend']) ||
        p.schemaVersion !== 1 || !iso(p.collectedAt) ||
        !keys(p.producer,['identity','verified']) || p.producer.identity !== SYSTEM_SID || p.producer.verified !== true) return false;
    if (p.task === null) {
        if (!taskReasons.includes(p.taskReason)) return false;
    } else if (!keys(p.task,['state','enabled','lastRun','nextRun','lastResult']) ||
        !taskStates.includes(p.task.state) || typeof p.task.enabled !== 'boolean' ||
        !nullableDate(p.task.lastRun) || !nullableDate(p.task.nextRun) ||
        !Number.isSafeInteger(p.task.lastResult) || p.taskReason !== null) return false;
    if (!keys(p.backend,['verified','configurationMatched','pid','reason'])) return false;
    if (p.backend.verified === true) {
        return pid(p.backend.pid) &&
            ((p.backend.reason === 'verified' && p.backend.configurationMatched === true) ||
             (p.backend.reason === 'configuration-mismatch' && p.backend.configurationMatched === false));
    }
    return p.backend.verified === null && p.backend.configurationMatched === null && p.backend.pid === null &&
        backendReasons.includes(p.backend.reason);
}

function base64(value) {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
    const bytes = Buffer.from(value,'base64');
    return bytes.toString('base64') === value ? bytes : null;
}
function snapshotError(code) { return Object.assign(new Error(code),{code}); }

function decodeSnapshot(bytes, publicKey, now = Date.now()) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw snapshotError('snapshot-oversized');
    let envelope;
    try { envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
    catch { throw snapshotError('snapshot-malformed'); }
    if (!keys(envelope,['version','payload','signature'])) throw snapshotError('snapshot-malformed');
    if (envelope.version !== 1) throw snapshotError('snapshot-unsupported');
    const payloadBytes=base64(envelope.payload), signature=base64(envelope.signature);
    if (!payloadBytes || !signature || signature.length !== 64) throw snapshotError('snapshot-malformed');
    let valid;
    try {
        const key=publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
        valid=key.asymmetricKeyType === 'ed25519' && crypto.verify(null,payloadBytes,key,signature);
    } catch { throw snapshotError('snapshot-untrusted'); }
    if (!valid) throw snapshotError('snapshot-untrusted');
    let payload;
    try { payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payloadBytes)); }
    catch { throw snapshotError('snapshot-malformed'); }
    if (payload?.schemaVersion !== 1) throw snapshotError('snapshot-unsupported');
    if (!validatePayload(payload)) throw snapshotError('snapshot-invalid');
    const ageMs=now-Date.parse(payload.collectedAt);
    if (!Number.isFinite(now) || ageMs > MAX_AGE_MS || ageMs < -FUTURE_SKEW_MS) throw snapshotError('snapshot-stale');
    return {payload,freshness:{ageMs:Math.max(0,ageMs),maxAgeMs:MAX_AGE_MS}};
}

async function readSnapshot(file, publicKey, now = Date.now) {
    let handle;
    try {
        handle=await fs.open(file,'r');
        const stat=await handle.stat();
        if (!stat.isFile()) throw snapshotError('snapshot-invalid');
        if (stat.size > MAX_BYTES) throw snapshotError('snapshot-oversized');
        const buffer=Buffer.alloc(MAX_BYTES+1);
        let length=0;
        while (length < buffer.length) {
            const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);
            if (!bytesRead) break;
            length+=bytesRead;
        }
        if (length > MAX_BYTES) throw snapshotError('snapshot-oversized');
        return decodeSnapshot(buffer.subarray(0,length),publicKey,typeof now === 'function' ? now() : now);
    } catch (error) {
        if (error.code === 'ENOENT') throw snapshotError('snapshot-missing');
        if (typeof error.code === 'string' && error.code.startsWith('snapshot-')) throw error;
        throw snapshotError('snapshot-unavailable');
    } finally { if (handle) await handle.close(); }
}

function collectEvidence() {
    return new Promise((resolve,reject) => execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-watchdog-snapshot-evidence.ps1')],
        {shell:false,windowsHide:true,timeout:8000,maxBuffer:32768,encoding:'utf8'},
        (error,stdout) => {
            if (error) return reject(snapshotError('producer-evidence-unavailable'));
            try { resolve(JSON.parse(stdout)); } catch { reject(snapshotError('producer-evidence-unavailable')); }
        }));
}

function assertProtectedDirectory(directory) {
    return new Promise((resolve,reject) => execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-watchdog-snapshot-directory.ps1'),'-Directory',directory],
        {shell:false,windowsHide:true,timeout:8000,maxBuffer:4096,encoding:'utf8'},
        (error,stdout) => error ? reject(snapshotError('producer-directory-unverified')) : resolve(stdout.trim() === 'protected')));
}

async function writeSnapshot(file, bytes) {
    const temporary=path.join(path.dirname(file),'.watchdog-'+crypto.randomUUID()+'.tmp');
    let handle, created=false, renamed=false;
    try {
        handle=await fs.open(temporary,'wx',0o600); created=true;
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close(); handle=null;
        await fs.rename(temporary,file); renamed=true;
    } finally {
        if (handle) await handle.close();
        if (created && !renamed) await fs.unlink(temporary);
    }
}

// Dependencies are supplied only by trusted local integration code, never by HTTP.
function createSnapshotProducer({collect=collectEvidence,assertDirectory=assertProtectedDirectory,privateKey,now=Date.now,write=writeSnapshot}) {
    return async file => {
        try { if (await assertDirectory(path.dirname(file)) !== true) throw snapshotError('producer-directory-unverified'); }
        catch { throw snapshotError('producer-directory-unverified'); }
        let evidence;
        try { evidence=await collect(); } catch { throw snapshotError('producer-evidence-unavailable'); }
        if (!keys(evidence,['identity','status']) || evidence.identity !== SYSTEM_SID || !evidence.status ||
            typeof evidence.status !== 'object' || Array.isArray(evidence.status)) throw snapshotError('producer-untrusted');
        const timestamp=now();
        if (!Number.isFinite(timestamp)) throw snapshotError('producer-clock-invalid');
        const status=normalize(evidence.status,timestamp);
        const payload={schemaVersion:1,collectedAt:new Date(timestamp).toISOString(),
            producer:{identity:SYSTEM_SID,verified:true},task:status.task,taskReason:status.taskReason,
            backend:status.backend || {verified:null,configurationMatched:null,pid:null,reason:'evidence-unavailable'}};
        if (!validatePayload(payload)) throw snapshotError('producer-evidence-unavailable');
        const payloadBytes=Buffer.from(JSON.stringify(payload),'utf8');
        let signature;
        try {
            const key=privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
            if (key.asymmetricKeyType !== 'ed25519') throw snapshotError('producer-key-invalid');
            signature=crypto.sign(null,payloadBytes,key);
        } catch { throw snapshotError('producer-key-invalid'); }
        const bytes=Buffer.from(JSON.stringify({version:1,payload:payloadBytes.toString('base64'),signature:signature.toString('base64')}),'utf8');
        if (bytes.length > MAX_BYTES) throw snapshotError('snapshot-oversized');
        try { if (await assertDirectory(path.dirname(file)) !== true) throw snapshotError('producer-directory-unverified'); }
        catch { throw snapshotError('producer-directory-unverified'); }
        try { await write(file,bytes); } catch { throw snapshotError('producer-write-failed'); }
    };
}

function createSnapshotStatus({file,publicKey,fallback,now=Date.now}) {
    return async () => {
        const status=await fallback();
        let snapshot;
        try { snapshot=await readSnapshot(file,publicKey,now); }
        catch (error) { return {status,snapshot:{available:false,reason:typeof error.code === 'string' && error.code.startsWith('snapshot-') ? error.code : 'snapshot-unavailable'}}; }
        return {status:{...status,task:snapshot.payload.task,taskReason:snapshot.payload.taskReason,
            backend:snapshot.payload.backend},snapshot:{available:true,collectedAt:snapshot.payload.collectedAt,...snapshot.freshness}};
    };
}
module.exports={MAX_BYTES,MAX_AGE_MS,FUTURE_SKEW_MS,validatePayload,decodeSnapshot,readSnapshot,writeSnapshot,createSnapshotProducer,createSnapshotStatus};
