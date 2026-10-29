'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createTestBoundary,openTestChannel} = require('./support/management-channel.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(t, options={}) {
    let time=100, timer, calls=[];
    const handle={};
    const evidence=r=>({at:time,authenticatedAdmin:true,sessionValid:true,channelVerified:true,lockHeld:true,
        operationId:r.operationId,revision:2,profileDigest:'a'.repeat(64),qualified:true,retainedHandle:handle,
        identityVerified:true,owned:true,foreignListener:false});
    const boundary=createTestBoundary({mode:'TEST',now:()=>time,leaseVerified:()=>true,
        observe:async r=>evidence(r),broker:async r=>{calls.push(r);return {...r,status:'owned'};},
        schedule:f=>{timer=f;return 1},cancel:()=>{},...options});
    const channel=await openTestChannel({mode:'TEST',boundary,now:()=>time});
    t.after(()=>channel.close());
    return {channel,boundary,calls,evidence,expire:()=>timer(),advance:n=>time=n};
}
test('TEST only; actual loopback HTTP authenticated fixture dispatch and sanitized response',async t=>{
    assert.throws(()=>createTestBoundary({mode:'PRODUCTION'}));
    const f=await fixture(t);assert.equal(f.channel.address.address,'127.0.0.1');
    const r=await f.channel.request();assert.equal(r.state,'accepted');assert.equal(r.productionReady,false);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].command,'STATUS');
    assert.deepEqual(Object.keys(r).sort(),['code','mode','productionReady','state','version']);
});
test('authentication, authorization, malformed and expired frames rejected',async t=>{
    const f=await fixture(t);
    assert.equal((await f.channel.request({}, {badMac:true})).code,'UNAUTHENTICATED');
    assert.equal((await f.channel.request({actor:'intruder'})).code,'UNAUTHORIZED');
    for(const patch of [{extra:true},{version:2},{expectedRevision:-1},{profileDigest:'invalid'},{action:'kill'},{operationId:[]}])
        assert.equal((await f.channel.request(patch)).code,'MALFORMED');
    for(const patch of [{expiresAt:100},{issuedAt:101},{expiresAt:30101}])
        assert.equal((await f.channel.request(patch)).code,'EXPIRED');
    assert.equal((await f.channel.request({}, {raw:'{'})).code,'MALFORMED');
    assert.equal(f.calls.length,0);
});
test('replay rejected after completion and stale revision never reaches broker',async t=>{
    const f=await fixture(t);
    assert.equal((await f.channel.request({operationId:'once'})).state,'accepted');
    assert.equal((await f.channel.request({operationId:'once'})).code,'REPLAY');
    assert.equal((await f.channel.request({expectedRevision:3})).code,'STALE_CONFIGURATION');
    assert.equal(f.calls.length,1);
});
test('activation and recovery/start/stop share boundary while observation is pending',async t=>{
    const entered=deferred(), release=deferred();let f;
    f=await fixture(t,{observe:async r=>{entered.resolve();await release.promise;return f.evidence(r)}});
    const pending=f.channel.request();await entered.promise;
    for(const action of ['activate','recovery','start','stop']) assert.equal((await f.channel.request({action})).state,'conflicting');
    release.resolve();assert.equal((await pending).state,'accepted');
});
test('lease loss and ownership uncertainty fail closed',async t=>{
    for(const options of [{leaseVerified:()=>false},{leaseVerified:()=>{throw Error('secret')}},
        {observe:async()=>({at:100})}]) {
        const f=await fixture(t,options);const r=await f.channel.request();
        assert.notEqual(r.state,'accepted');assert.equal(f.calls.length,0);assert.ok(!JSON.stringify(r).includes('secret'));
    }
});
test('timeout during observation poisons gate and delayed evidence cannot dispatch',async t=>{
    const entered=deferred(),release=deferred();let f;
    f=await fixture(t,{observe:async r=>{entered.resolve();await release.promise;return f.evidence(r)}});
    const pending=f.channel.request();await entered.promise;f.expire();
    assert.equal((await pending).state,'timed-out');release.resolve();
    await new Promise(setImmediate);
    assert.equal(f.calls.length,0);assert.equal((await f.channel.request()).code,'CHANNEL_POISONED');
});
test('late broker reply cannot reopen timed-out channel or dispatch another command',async t=>{
    const entered=deferred(),release=deferred();let count=0;
    const f=await fixture(t,{broker:async r=>{count++;entered.resolve();await release.promise;return {...r,status:'owned'}}});
    const pending=f.channel.request();await entered.promise;f.expire();
    assert.equal((await pending).state,'timed-out');release.resolve();await new Promise(setImmediate);
    assert.equal((await f.channel.request()).code,'CHANNEL_POISONED');assert.equal(count,1);
});
test('mismatched broker sequence poisons session; raw errors not exposed',async t=>{
    const f=await fixture(t,{broker:async r=>({...r,sequence:999,status:'owned',secret:'DO_NOT_LOG'})});
    const r=await f.channel.request();assert.equal(r.state,'unverifiable');
    assert.ok(!JSON.stringify(r).includes('DO_NOT_LOG'));assert.equal((await f.channel.request()).code,'CHANNEL_POISONED');
});
test('request expiring during preflight cannot dispatch',async t=>{
    const entered=deferred(),release=deferred();let f;
    f=await fixture(t,{observe:async r=>{entered.resolve();await release.promise;return f.evidence(r)}});
    const pending=f.channel.request({expiresAt:150});await entered.promise;f.advance(150);release.resolve();
    assert.equal((await pending).state,'unverifiable');assert.equal(f.calls.length,0);
});
test('closed channel explicitly unavailable',async t=>{
    const f=await fixture(t);await f.channel.close();assert.equal((await f.channel.request()).code,'CHANNEL_UNAVAILABLE');
});

test('channel closure while preflight is pending revokes dispatch capability',async t=>{
    const entered=deferred(),release=deferred();let f;
    f=await fixture(t,{observe:async r=>{entered.resolve();await release.promise;return f.evidence(r)}});
    const pending=f.channel.request();await entered.promise;await f.channel.close();release.resolve();
    await pending;await new Promise(setImmediate);assert.equal(f.calls.length,0);
});
