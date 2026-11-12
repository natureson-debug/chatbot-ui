'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {MAX_BYTES,MAX_AGE_MS,FUTURE_SKEW_MS,decodeSnapshot,readSnapshot,writeSnapshot,createSnapshotProducer,createSnapshotStatus}=require('../core/watchdog-snapshot');
const {normalize}=require('../core/watchdog-status');
const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
const now=Date.parse('2026-11-12T10:00:00.000Z');
const task={state:'Running',enabled:true,lastRun:'2026-11-12T09:59:00.000Z',nextRun:null,lastResult:0};
const backend={verified:true,configurationMatched:true,pid:14248,reason:'verified'};
const evidence=()=>({identity:'S-1-5-18',status:{task,backend}});
async function fixture(t) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'watchdog-snapshot-test-'));
    const file=path.join(dir,'snapshot.json');
    t.after(async()=>{try{await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;} await fs.rmdir(dir);});
    return {dir,file};
}
const producer=(overrides={})=>createSnapshotProducer({collect:async()=>evidence(),assertDirectory:async()=>true,privateKey,now:()=>now,...overrides});
const expectCode=(promise,code)=>assert.rejects(promise,e=>e.code===code && e.message===code);
function signPayload(payload,key=privateKey) {
    const bytes=Buffer.from(JSON.stringify(payload));
    return Buffer.from(JSON.stringify({version:1,payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,key).toString('base64')}));
}
const payload=()=>({schemaVersion:1,collectedAt:new Date(now).toISOString(),producer:{identity:'S-1-5-18',verified:true},task,taskReason:null,backend});

test('valid fresh signed snapshot is atomically replaced and can be consumed',async t=>{
    const {file}=await fixture(t); await fs.writeFile(file,'old');
    await producer()(file);
    const result=await readSnapshot(file,publicKey,now+1000);
    assert.deepEqual(result.payload,payload());assert.deepEqual(result.freshness,{ageMs:1000,maxAgeMs:MAX_AGE_MS});
});
test('missing snapshot falls back without changing existing status',async t=>{
    const {file}=await fixture(t); const original=normalize(null,now);
    const sample=createSnapshotStatus({file,publicKey,now:()=>now,fallback:async()=>original});
    assert.deepEqual(await sample(),{status:original,snapshot:{available:false,reason:'snapshot-missing'}});
});
test('rejects stale and future snapshots and accepts exact bounds',()=>{
    const bytes=signPayload(payload());
    assert.throws(()=>decodeSnapshot(bytes,publicKey,now+MAX_AGE_MS+1),{code:'snapshot-stale'});
    assert.throws(()=>decodeSnapshot(bytes,publicKey,now-FUTURE_SKEW_MS-1),{code:'snapshot-stale'});
    assert.equal(decodeSnapshot(bytes,publicKey,now+MAX_AGE_MS).freshness.ageMs,MAX_AGE_MS);
    assert.equal(decodeSnapshot(bytes,publicKey,now-FUTURE_SKEW_MS).freshness.ageMs,0);
});
test('rejects corrupt, truncated, oversized and unsupported snapshots',async t=>{
    const {file}=await fixture(t);
    for(const text of ['{','{"version":1,"payload":"%%%","signature":""}','\ufffd']){
        await fs.writeFile(file,text); await expectCode(readSnapshot(file,publicKey,now),'snapshot-malformed');
    }
    await fs.writeFile(file,Buffer.alloc(MAX_BYTES+1));await expectCode(readSnapshot(file,publicKey,now),'snapshot-oversized');
    await fs.writeFile(file,JSON.stringify({version:2,payload:'',signature:''}));await expectCode(readSnapshot(file,publicKey,now),'snapshot-unsupported');
    const unsupported=payload();unsupported.schemaVersion=2;
    await fs.writeFile(file,signPayload(unsupported));await expectCode(readSnapshot(file,publicKey,now),'snapshot-unsupported');
});
test('unverified ownership and genuine mismatch stay distinct',async t=>{
    const {file}=await fixture(t);
    const unavailable={verified:false,configurationMatched:false,pid:123,reason:'evidence-unavailable'};
    await producer({collect:async()=>({identity:'S-1-5-18',status:{task,backend:unavailable}})})(file);
    let result=await readSnapshot(file,publicKey,now);
    assert.deepEqual(result.payload.backend,{verified:null,configurationMatched:null,pid:null,reason:'evidence-unavailable'});
    const mismatch={verified:true,configurationMatched:false,pid:14248,reason:'configuration-mismatch'};
    await producer({collect:async()=>({identity:'S-1-5-18',status:{task,backend:mismatch}})})(file);
    result=await readSnapshot(file,publicKey,now);assert.deepEqual(result.payload.backend,mismatch);
});
test('atomic write failure leaves the prior destination intact and removes temporary file',async t=>{
    const {dir}=await fixture(t);const target=path.join(dir,'blocked');await fs.mkdir(target);
    try { await assert.rejects(writeSnapshot(target,Buffer.from('data')));assert.deepEqual(await fs.readdir(dir),['blocked']); }
    finally { await fs.rmdir(target); }
});
test('producer refuses untrusted identity, unprotected directory, invalid key and write failure',async t=>{
    const {file}=await fixture(t);await fs.writeFile(file,'original');let wrote=false;
    const write=async()=>{wrote=true;throw Error('sensitive');};
    await expectCode(producer({collect:async()=>({identity:'S-1-5-32-544',status:{task,backend}}),write})(file),'producer-untrusted');
    await expectCode(producer({assertDirectory:async()=>false,write})(file),'producer-directory-unverified');
    await expectCode(producer({privateKey:'invalid',write})(file),'producer-key-invalid');
    assert.equal(wrote,false);await expectCode(producer({write})(file),'producer-write-failed');assert.equal(await fs.readFile(file,'utf8'),'original');
});
test('producer rechecks directory immediately before writing',async t=>{
    const {file}=await fixture(t);let checks=0,wrote=false;
    await expectCode(producer({assertDirectory:async()=>++checks===1,write:async()=>{wrote=true;}})(file),'producer-directory-unverified');
    assert.equal(checks,2);assert.equal(wrote,false);
});
test('invalid signature and unauthorized signed identity never become trusted',()=>{
    const other=crypto.generateKeyPairSync('ed25519');
    assert.throws(()=>decodeSnapshot(signPayload(payload(),other.privateKey),publicKey,now),{code:'snapshot-untrusted'});
    const envelope=JSON.parse(signPayload(payload()).toString());
    envelope.payload=Buffer.from(JSON.stringify({...payload(),backend:{...backend,pid:1}})).toString('base64');
    assert.throws(()=>decodeSnapshot(Buffer.from(JSON.stringify(envelope)),publicKey,now),{code:'snapshot-untrusted'});
    const wrong=payload();wrong.producer={identity:'S-1-5-32-544',verified:true};
    assert.throws(()=>decodeSnapshot(signPayload(wrong),publicKey,now),{code:'snapshot-invalid'});
    wrong.producer={identity:'S-1-5-18',verified:false};
    assert.throws(()=>decodeSnapshot(signPayload(wrong),publicKey,now),{code:'snapshot-invalid'});
});
test('partial snapshot preserves unavailable evidence and excludes sensitive fields',async t=>{
    const {file}=await fixture(t);
    await producer({collect:async()=>({identity:'S-1-5-18',status:{taskReason:'task-access-denied',backend:{verified:false,reason:'evidence-unavailable',commandLine:'secret'},secret:'secret'}})})(file);
    const result=await readSnapshot(file,publicKey,now);
    assert.equal(result.payload.task,null);assert.equal(result.payload.taskReason,'task-access-denied');
    assert.equal(result.payload.backend.verified,null);assert(!JSON.stringify(result).includes('secret'));
});
test('strict validation rejects forged success, unexpected fields and malformed dates',()=>{
    const bad=[
        {...payload(),backend:{verified:true,configurationMatched:true,pid:null,reason:'verified'}},
        {...payload(),backend:{verified:null,configurationMatched:false,pid:null,reason:'configuration-mismatch'}},
        {...payload(),backend:{verified:false,configurationMatched:false,pid:14248,reason:'configuration-mismatch'}},
        {...payload(),extra:'secret'},
        {...payload(),collectedAt:'2026-11-12T10:00:00Z'},
        {...payload(),task:{...task,lastRun:'bad'}}
    ];
    for(const p of bad) assert.throws(()=>decodeSnapshot(signPayload(p),publicKey,now),{code:'snapshot-invalid'});
});
test('trusted snapshot overlays verified fields without replacing independent observations',async t=>{
    const {file}=await fixture(t);await producer()(file);
    const fallback={...normalize({marker:'absent',observedListenerPid:19},now),availability:'observed'};
    const result=await createSnapshotStatus({file,publicKey,now:()=>now+5,fallback:async()=>fallback})();
    assert.deepEqual(result.status.task,task);assert.deepEqual(result.status.backend,backend);
    assert.equal(result.status.marker,'absent');assert.equal(result.status.observedListenerPid,19);
    assert.equal(result.snapshot.available,true);assert.equal(result.snapshot.ageMs,5);
});
test('untrusted or stale snapshot always uses fallback without leaking errors',async t=>{
    const {file}=await fixture(t);const fallback=normalize(null,now);
    await fs.writeFile(file,signPayload(payload(),crypto.generateKeyPairSync('ed25519').privateKey));
    let sample=createSnapshotStatus({file,publicKey,now:()=>now,fallback:async()=>fallback});
    assert.deepEqual(await sample(),{status:fallback,snapshot:{available:false,reason:'snapshot-untrusted'}});
    await fs.writeFile(file,signPayload(payload()));
    sample=createSnapshotStatus({file,publicKey,now:()=>now+MAX_AGE_MS+1,fallback:async()=>fallback});
    assert.deepEqual(await sample(),{status:fallback,snapshot:{available:false,reason:'snapshot-stale'}});
});
test('freshness is checked after fallback sampling, not before it',async t=>{
    const {file}=await fixture(t);await producer()(file);let clock=now;
    const fallback=normalize(null,now);
    const sample=createSnapshotStatus({file,publicKey,now:()=>clock,fallback:async()=>{clock=now+MAX_AGE_MS+1;return fallback;}});
    assert.deepEqual(await sample(),{status:fallback,snapshot:{available:false,reason:'snapshot-stale'}});
});
