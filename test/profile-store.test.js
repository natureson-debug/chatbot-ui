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
test('persistent immutable revisions and canonical profile digest across reopening',t=>{
 const f=fixture(t),s=f.open();const a=s.append({expectedRevision:null,profileId:'approved'});assert.equal(a.revision,0);
 assert.equal(a.profileDigest,hash(require('./support/profile-store.cjs').canonical(a.profile)));
 s.append({expectedRevision:0,profileId:'approved'});s.close();assert.equal(f.open().history().length,2);
});
test('two connections cannot overwrite: CAS and live write lock',t=>{
 const f=fixture(t),a=f.open(),b=f.open();a.append({expectedRevision:null,profileId:'approved'});
 a.append({expectedRevision:0,profileId:'approved'},()=>assert.throws(()=>b.append({expectedRevision:0,profileId:'approved'}),/locked/));
 assert.throws(()=>b.append({expectedRevision:0,profileId:'approved'}),/STALE_REVISION/);assert.equal(b.history().length,2);
});
test('interrupted transaction rollback preserves committed revisions',t=>{
 const f=fixture(t),s=f.open();s.append({expectedRevision:null,profileId:'approved'});
 assert.throws(()=>s.append({expectedRevision:0,profileId:'approved'},()=>{throw Error('injected interruption')}));
 assert.equal(s.history().length,1);
 const raw=new DatabaseSync(path.join(f.root,'revisions.sqlite'));raw.exec('BEGIN IMMEDIATE');
 raw.exec("INSERT INTO revisions VALUES(1,'uncommitted','x','x','x')");raw.close();
 assert.equal(s.history().length,1);assert.equal(s.append({expectedRevision:0,profileId:'approved'}).revision,1);
});
test('unknown/stale/digest mismatch rejected and frozen target cannot silently change',t=>{
 const f=fixture(t),s=f.open(),a=s.append({expectedRevision:null,profileId:'approved'});
 const r={operationId:'op-1',expectedRevision:0,profileDigest:a.profileDigest};const bound=s.bind(r);
 assert.throws(()=>s.bind({...r,expectedRevision:9}),/UNKNOWN/);assert.throws(()=>s.bind({...r,profileDigest:'b'.repeat(64)}),/MISMATCH/);
 s.append({expectedRevision:0,profileId:'approved'});assert.throws(()=>s.revalidate(bound),/SUPERSEDED/);
 assert.equal(bound.revision,0);assert.throws(()=>{bound.profile.settings.contextSize=1024},TypeError);
});
test('request cannot override approved model/executable/security or add CLI args',t=>{
 const f=fixture(t),s=f.open();assert.throws(()=>s.append({expectedRevision:null,profileId:'unknown'}),/UNAPPROVED/);
 for(const extra of [{args:['--no-auth']},{modelPath:'C:\\other.gguf'},{host:'0.0.0.0'}])assert.throws(()=>s.append({expectedRevision:null,profileId:'approved',...extra}),/INVALID_REQUEST/);
});
test('trusted metadata still requires actual approved model and executable bytes',t=>{
 const f=fixture(t),s=f.open();fs.writeFileSync(path.join(f.root,'model.gguf'),'tampered');assert.throws(()=>s.append({expectedRevision:null,profileId:'approved'}),/HASH/);
 fs.writeFileSync(path.join(f.root,'model.gguf'),'GGUF synthetic model');fs.writeFileSync(path.join(f.root,'fixture.exe'),'changed');assert.throws(()=>s.append({expectedRevision:null,profileId:'approved'}),/HASH/);
});
test('invalid trusted paths and weakened network rejected',t=>{
 const f=fixture(t);f.approvals.approved.settings.modelPath=path.join(f.root,'..','outside.gguf');assert.throws(()=>f.open().append({expectedRevision:null,profileId:'approved'}),/PATH/);
 f.approvals.approved.settings.modelPath=path.join(f.root,'model.gguf');f.approvals.approved.settings.host='0.0.0.0';assert.throws(()=>f.open().append({expectedRevision:null,profileId:'approved'}),/SECURITY/);
});
test('SQL mutation blocked; bypassed trigger tampering detected by external-key seal',t=>{
 const f=fixture(t),s=f.open();s.append({expectedRevision:null,profileId:'approved'});const raw=new DatabaseSync(path.join(f.root,'revisions.sqlite'));
 try{assert.throws(()=>raw.exec("UPDATE revisions SET digest='changed'"),/immutable/);raw.exec("DROP TRIGGER revisions_no_update; UPDATE revisions SET digest='changed'");assert.throws(()=>s.history(),/TAMPERED/);}finally{raw.close()}
});
test('management channel accepts bound revision and rejects superseded target',async t=>{
 const f=fixture(t),s=f.open(),a=s.append({expectedRevision:null,profileId:'approved'});let calls=0;
 const boundary=createTestBoundary({mode:'TEST',leaseVerified:()=>true,observe:async r=>{
  const b=s.bind(r);return {at:Date.now(),authenticatedAdmin:true,sessionValid:true,channelVerified:true,lockHeld:true,operationId:b.operationId,revision:b.revision,profileDigest:b.profileDigest,qualified:true,retainedHandle:{},identityVerified:true,owned:true,foreignListener:false};
 },broker:async r=>{calls++;return {...r,status:'owned'}}});
 const c=await openTestChannel({mode:'TEST',boundary});try{
 assert.equal((await c.request({expectedRevision:0,profileDigest:a.profileDigest})).state,'accepted');
 s.append({expectedRevision:0,profileId:'approved'});assert.notEqual((await c.request({expectedRevision:0,profileDigest:a.profileDigest})).state,'accepted');assert.equal(calls,1);
 }finally{await c.close()}
});
