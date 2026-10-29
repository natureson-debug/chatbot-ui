'use strict';
// Explicit opt-in: actual harmless native fixtures only; never production providers.
if(process.argv[2]!=='--run-harmless-fixtures')throw Error('EXPLICIT_FIXTURE_OPT_IN_REQUIRED');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),net=require('node:net'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {build}=require('C:/Users/Admin/AppData/Local/Chatbot/startup/v1/build.cjs');
const {open}=require('./broker-client.cjs');
const {openFixtureStore,hash}=require('../support/profile-store.cjs');
const {openCoordinator}=require('../support/activation-coordinator.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatbot-profile-test-'));
const clients=[];let store,coordinator,lease;let port,passed=0;
function pass(name){passed++;console.log('PASS '+name);}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));assert(![443,3000,8080,18080].includes(p));return p;}
async function status(b){const end=Date.now()+4000;while(Date.now()<end){const s=await b.request('STATUS');if(s.status==='owned'&&s.listener)return s;if(s.status==='exited')throw Error('FIXTURE_EXITED');await sleep(20);}throw Error('FIXTURE_START_TIMEOUT');}
async function stop(b){const s=await b.request('STOP');assert(['exited','graceful-complete'].includes(s.status));assert(s.streamsClosed&&s.listenerReleased);await b.request('QUIT');return s;}
async function main(){
 console.log('FIXTURE_ROOT '+root);
 port=await freePort();
 const exe=path.join(root,'fixture.exe'),source=path.resolve(__dirname,'fixture.cpp');
 const cmd=path.join(root,'compile.cmd');
 fs.writeFileSync(cmd,'@echo off\r\ncall "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat" x64 10.0.22621.0\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /std:c++17 /EHsc /MT /Fe"'+exe+'" /Fo"'+path.join(root,'fixture.obj')+'" "'+source+'" /link /MACHINE:X64 ws2_32.lib\r\n');
 const compiled=spawnSync(process.env.ComSpec,['/d','/c',cmd],{cwd:root,windowsHide:true,encoding:'utf8',timeout:60000});
 fs.writeFileSync(path.join(root,'compile.log'),(compiled.stdout||'')+(compiled.stderr||''));assert.equal(compiled.status,0,'fixture compilation');
 const aDir=path.join(root,'a'),bDir=path.join(root,'b');
 const aExe=build({executable:exe,cwd:root,args:[String(port),'fixture-a','normal'],port,host:'127.0.0.1',fixture:true,shutdownMs:1000},aDir);
 const bExe=build({executable:exe,cwd:root,args:[String(port),'fixture-b','normal'],port,host:'127.0.0.1',fixture:true,shutdownMs:1000},bDir);
 lease=fs.openSync(path.join(root,'experiment.lease'),'wx');
 for(const name of ['a.gguf','b.gguf'])fs.writeFileSync(path.join(root,name),'GGUF '+name);
 fs.writeFileSync(path.join(root,'key.txt'),'fixture-only-not-used-by-native');
 const settings={platform:'win32',executable:exe,cwd:root,apiKeyFile:path.join(root,'key.txt'),host:'127.0.0.1',port,corsOrigin:'http://127.0.0.1:'+port,device:'none',gpuLayers:0,contextSize:1024,parallel:1,verbosity:0};
 const approval=name=>({version:1,settings:{...settings,modelPath:path.join(root,name+'.gguf')},gpuIdentity:'fixture-cpu',executableSha256:hash(fs.readFileSync(exe)),modelSha256:hash('GGUF '+name+'.gguf')});
 store=openFixtureStore({mode:'TEST',root,approvals:{a:approval('a'),b:approval('b')},integrityKey:crypto.randomBytes(32)});
 const target=store.append({expectedRevision:null,profileId:'b'});
 // Foreign listener is owned by this harness, not by the native broker.
 const foreign=net.createServer();await new Promise(r=>foreign.listen(port,'127.0.0.1',r));
 const denied=await open(aExe,aDir);clients.push(denied);
 await assert.rejects(denied.request('START'));assert(foreign.listening);
 denied.disconnect();await denied.exit;await new Promise(r=>foreign.close(r));pass('foreign listener rejected and preserved');
 const original=await open(aExe,aDir);clients.push(original);await original.request('START');const identity=await status(original);
 console.log('ORIGINAL '+JSON.stringify({pid:identity.pid,created:identity.created,port}));pass('original retained identity and listener');
 const oldToken={},newToken={};let replacement=null,newIdentity=null;
 const base=bound=>({at:Date.now(),operationId:bound.operationId,revision:bound.revision,profileDigest:bound.profileDigest,authenticatedAdmin:true,sessionValid:true,channelVerified:true,lockHeld:true,qualified:true,owned:true,identityVerified:true,foreignListener:false});
 coordinator=await openCoordinator({mode:'TEST',store,timeoutMs:12000,leaseVerified:()=>lease!==undefined,
 observe:async bound=>{const s=await original.request('STATUS');assert.equal(s.pid,identity.pid);assert.equal(s.created,identity.created);assert.equal(s.status,'owned');assert(s.listener);return {...base(bound),retainedHandle:oldToken};},
 simulate:async(stage,bound)=>{
  assert.equal(bound.profileDigest,target.profileDigest);assert.equal(bound.profile.profileId,'b');
  if(stage==='stop'){const s=await stop(original);pass('cooperative original exit, streams closed, listener released');return {...base(bound),retainedHandle:oldToken,exited:true,streamsClosed:s.streamsClosed,listenerReleased:s.listenerReleased};}
  if(stage==='launch'){replacement=await open(bExe,bDir);clients.push(replacement);await replacement.request('START');newIdentity=await status(replacement);return {retainedHandle:newToken,identityVerified:true};}
  const before=await replacement.request('STATUS');assert.equal(before.created,newIdentity.created);assert(before.listener);
  const response=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(1000)});assert.equal(response.status,200);const body=await response.json();assert.equal(body.model,'fixture-b');assert.equal(body.status,'ok');
  const after=await replacement.request('STATUS');assert.equal(after.pid,newIdentity.pid);assert.equal(after.created,newIdentity.created);assert(after.listener);
  // Fixture model mapping is preapproved/pinned; not evidence for GGUF loading.
  return {...base(bound),retainedHandle:newToken,listenerOwned:true,health:'ok',loadedModelPath:bound.profile.settings.modelPath,loadedModelDigest:bound.profile.modelSha256,modelApiIdentityVerified:true};
 }});
 const outcome=await coordinator.channel.request({operationId:'native-replacement',expectedRevision:target.revision,profileDigest:target.profileDigest,expiresAt:Date.now()+25000});
 assert.equal(outcome.state,'succeeded',JSON.stringify(outcome));pass('authenticated coordinator replacement and expected fixture model');
 console.log('REPLACEMENT '+JSON.stringify({pid:newIdentity.pid,created:newIdentity.created,port}));
 assert.notEqual(newIdentity.created,identity.created);await stop(replacement);pass('replacement cooperative cleanup');
 await coordinator.channel.close();coordinator=null;store.close();store=null;
 const s=net.createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(port,'127.0.0.1',resolve)});await new Promise(r=>s.close(r));pass('dedicated listener released');
}
main().catch(e=>{console.error('QUALIFICATION_FAILED '+e.message);process.exitCode=1;}).finally(async()=>{
 if(coordinator)await coordinator.channel.close();
 // Private pipe closure requests only owned cooperative cleanup; fixture self-expires at 15 seconds.
 for(const b of clients){b.disconnect();let timer;try{await Promise.race([b.exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CLEANUP_UNVERIFIED')),18000);})]);}finally{clearTimeout(timer);}}
 if(store)store.close();if(lease!==undefined){fs.closeSync(lease);lease=undefined;}
 assert.equal(path.dirname(root),fs.realpathSync(os.tmpdir()));
 for(const name of ['key.txt','revisions.sqlite','revisions.sqlite-journal','experiment.lease']){const p=path.join(root,name);if(fs.existsSync(p))fs.unlinkSync(p);}
 console.log('PASSED_CHECKS '+passed+'; artifacts retained at '+root);
});
