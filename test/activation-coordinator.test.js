'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {openFixtureStore,hash}=require('./support/profile-store.cjs');
const {createTestBoundary,openTestChannel}=require('./support/management-channel.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatbot-profile-test-'));const key=crypto.randomBytes(32);
 for(const [name,data] of [['fixture.exe','inert executable'],['model.gguf','GGUF synthetic model'],['key.txt','synthetic']])fs.writeFileSync(path.join(root,name),data);
 const settings={platform:process.platform,executable:path.join(root,'fixture.exe'),cwd:root,modelPath:path.join(root,'model.gguf'),apiKeyFile:path.join(root,'key.txt'),host:'127.0.0.1',port:18080,corsOrigin:'http://127.0.0.1:18080',device:'CUDA0',gpuLayers:37,contextSize:32768,parallel:1,verbosity:4};
 const approvals={approved:{version:1,settings,gpuIdentity:'fixture-gpu',executableSha256:hash('inert executable'),modelSha256:hash('GGUF synthetic model')}};
 const handles=[];const open=()=>{const s=openFixtureStore({mode:'TEST',root,approvals,integrityKey:key});handles.push(s);return s};
 t.after(()=>{for(const s of handles)try{s.close()}catch{};key.fill(0);assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true})});
 return {root,approvals,key,open};
}

const {openCoordinator,transition}=require('./support/activation-coordinator.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function integrated(t,overrides={}){
 const f=fixture(t),store=f.open(),saved=store.append({expectedRevision:null,profileId:'approved'});
 const old={},next={};let timer,calls=[];
 const evidence=b=>({at:Date.now(),operationId:b.operationId,revision:b.revision,profileDigest:b.profileDigest,
  authenticatedAdmin:true,sessionValid:true,channelVerified:true,lockHeld:true,qualified:true,owned:true,identityVerified:true,foreignListener:false,retainedHandle:old});
 const simulate=async(stage,b)=>{calls.push(stage);if(stage==='stop')return {...evidence(b),exited:true,streamsClosed:true,listenerReleased:true};
 if(stage==='launch')return {retainedHandle:next,identityVerified:true};
 return {...evidence(b),retainedHandle:next,listenerOwned:true,health:'ok',loadedModelPath:b.profile.settings.modelPath,loadedModelDigest:b.profile.modelSha256,modelApiIdentityVerified:true};};
 const c=await openCoordinator({mode:'TEST',store,observe:async b=>evidence(b),simulate,leaseVerified:()=>true,schedule:f=>{timer=f;return 1},cancel:()=>{},...overrides});
 t.after(()=>c.channel.close());
 const request=extra=>c.channel.request({expectedRevision:0,profileDigest:saved.profileDigest,...extra});
 return {...f,store,c,request,calls,evidence,simulate,expire:()=>timer()};
}
test('integrated authenticated activation succeeds with exact state trace; invalid transitions reject',async t=>{
 const f=await integrated(t);const r=await f.request();assert.equal(r.state,'succeeded');
 assert.deepEqual(r.trace,['requested','validated','accepted','activating','verifying','succeeded']);assert.deepEqual(f.calls,['stop','launch','verify']);
 assert.throws(()=>transition('requested','succeeded'),/INVALID_TRANSITION/);
});
test('configuration and duplicate activation conflict while operation pending; external writer locked',async t=>{
 const entered=deferred(),release=deferred();let f;
 f=await integrated(t,{simulate:async(stage,b)=>{if(stage==='stop'){entered.resolve();await release.promise;}return f.simulate(stage,b);}});
 const pending=f.request({operationId:'same'});await entered.promise;
 assert.equal(f.c.save({expectedRevision:0,profileId:'approved'}).state,'conflicting');
 assert.equal((await f.request({operationId:'same'})).state,'conflicting');
 const other=f.open();assert.throws(()=>other.append({expectedRevision:0,profileId:'approved'}),/locked/);
 release.resolve();assert.equal((await pending).state,'succeeded');assert.equal((await f.request({operationId:'same'})).code,'REPLAY');
 assert.equal(f.c.save({expectedRevision:0,profileId:'approved'}).state,'succeeded');
});
test('invalid authentication has no lifecycle or store effects',async t=>{
 const f=await integrated(t);assert.equal((await f.c.channel.request({}, {badMac:true})).code,'UNAUTHENTICATED');
 assert.equal(f.calls.length,0);assert.equal(f.store.incomplete(),false);
});
test('stale revision and digest mismatch rejected without effects',async t=>{
 const f=await integrated(t);assert.equal((await f.request({profileDigest:'b'.repeat(64)})).code,'PROFILE_DIGEST_MISMATCH');
 f.c.save({expectedRevision:0,profileId:'approved'});assert.equal((await f.request()).code,'SUPERSEDED_REVISION');assert.equal(f.calls.length,0);
});
test('unverified lifetime lock blocks all lifecycle effects',async t=>{
 const f=await integrated(t,{leaseVerified:()=>false});assert.equal((await f.request()).state,'unverifiable');assert.equal(f.calls.length,0);
});
test('broker timeout retains durable incomplete marker; delayed stop cannot launch',async t=>{
 const entered=deferred(),release=deferred();let f;
 f=await integrated(t,{simulate:async(stage,b)=>{entered.resolve();await release.promise;return f.simulate(stage,b);}});
 const pending=f.request();await entered.promise;f.expire();assert.equal((await pending).code,'TIMEOUT');
 release.resolve();await new Promise(setImmediate);assert.deepEqual(f.calls,['stop']);assert.equal(f.store.incomplete(),true);
 assert.equal(f.c.save({expectedRevision:0,profileId:'approved'}).state,'blocked');
 const reopened=f.open();assert.equal(reopened.incomplete(),true);assert.throws(()=>reopened.append({expectedRevision:0,profileId:'approved'}),/INCOMPLETE/);
 const retry=await openCoordinator({mode:'TEST',store:reopened,observe:async()=>{},simulate:async()=>{throw Error('must not run')},leaseVerified:()=>true});
 try{assert.equal((await retry.channel.request()).state,'unverifiable');}finally{await retry.channel.close();}
});
test('coordinator interruption rejects late observations before simulation',async t=>{
 const entered=deferred(),release=deferred();let f;
 f=await integrated(t,{observe:async b=>{entered.resolve();await release.promise;return f.evidence(b);}});
 const pending=f.request();await entered.promise;f.c.interrupt();assert.equal((await pending).code,'INTERRUPTED');
 release.resolve();await new Promise(setImmediate);assert.equal(f.calls.length,0);
});
test('model mismatch leaves incomplete operation and never retries or falsely succeeds',async t=>{
 let f;f=await integrated(t,{simulate:async(stage,b)=>{const e=await f.simulate(stage,b);return stage==='verify'?{...e,loadedModelDigest:'b'.repeat(64)}:e;}});
 assert.equal((await f.request()).code,'MODEL_MISMATCH');assert.equal(f.store.incomplete(),true);assert.equal((await f.request()).state,'unverifiable');
});

test('configuration changed through second connection during admission blocks effects',async t=>{
 const entered=deferred(),release=deferred();let f;
 f=await integrated(t,{observe:async b=>{entered.resolve();await release.promise;return f.evidence(b);}});
 const pending=f.request();await entered.promise;f.open().append({expectedRevision:0,profileId:'approved'});release.resolve();
 assert.equal((await pending).state,'unverifiable');assert.equal(f.calls.length,0);
});
test('incomplete shutdown prevents replacement and remains blocked across store reopen',async t=>{
 let f;f=await integrated(t,{simulate:async(stage,b)=>({...await f.simulate(stage,b),listenerReleased:false})});
 assert.equal((await f.request()).code,'SHUTDOWN_UNVERIFIABLE');assert.deepEqual(f.calls,['stop']);assert.equal(f.open().incomplete(),true);
});

test('external process evidence never reaches shutdown',async t=>{
 let f;f=await integrated(t,{observe:async b=>({...f.evidence(b),owned:false})});
 assert.equal((await f.request()).code,'OWNERSHIP_BLOCKED');assert.deepEqual(f.calls,[]);
});
test('invalid identity blocks and swapped original handle rejects replacement',async t=>{
 let f;f=await integrated(t,{observe:async b=>({...f.evidence(b),identityVerified:false})});
 assert.equal((await f.request()).code,'OWNERSHIP_BLOCKED');assert.deepEqual(f.calls,[]);
 let g;g=await integrated(t,{simulate:async(stage,b)=>({...await g.simulate(stage,b),retainedHandle:{}})});
 assert.equal((await g.request()).code,'SHUTDOWN_UNVERIFIABLE');assert.deepEqual(g.calls,['stop']);
});
test('replacement startup failure blocks subsequent attempts without implicit retry',async t=>{
 let f;f=await integrated(t,{simulate:async(stage,b)=>{if(stage==='launch')throw Error('synthetic private detail');return f.simulate(stage,b);}});
 const r=await f.request();assert.equal(r.state,'unverifiable');assert.ok(!JSON.stringify(r).includes('private detail'));assert.equal(f.store.incomplete(),true);
 assert.equal((await f.request()).state,'unverifiable');
});
test('health verification timeout and late reply cannot mark success',async t=>{
 const entered=deferred(),release=deferred();let f;
 f=await integrated(t,{simulate:async(stage,b)=>{if(stage==='verify'){entered.resolve();await release.promise;}return f.simulate(stage,b);}});
 const pending=f.request();await entered.promise;f.expire();assert.equal((await pending).code,'TIMEOUT');release.resolve();await new Promise(setImmediate);
 assert.equal(f.store.incomplete(),true);assert.equal((await f.request()).state,'unverifiable');
});
