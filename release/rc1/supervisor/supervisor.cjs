'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{performance}=require('node:perf_hooks');
const {open}=require('./broker-client.cjs'),{hash}=require('./build.cjs'),{budget,classify}=require('./recovery.cjs');
const {waitReady}=require('./readiness.cjs');
const {TIMEOUTS}=require('./timeouts.cjs');
const root=__dirname,profile=require('./profile.json'),state=path.join(root,'state');
const shell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixedLog(code,service){const log=path.join(state,'events.jsonl'),old=path.join(state,'events.previous.jsonl'); if(fs.existsSync(log)&&fs.statSync(log).size>1048576){if(fs.existsSync(old))fs.unlinkSync(old);fs.renameSync(log,old);}fs.appendFileSync(path.join(state,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),code,service})+'\n');}
function runObserver(service){
 return new Promise((resolve,reject)=>{
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,service==='environment'?'verify-environment.ps1':'observe.ps1')]; if(service!=='environment')args.push('-Service',service); const p=spawn(shell,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
  let text='',settled=false;const timer=setTimeout(()=>{settled=true;reject(Error('OBSERVATION_TIMEOUT'));},TIMEOUTS.observerMs);
  p.stdout.on('data',b=>{if(settled)return;text+=b;if(text.length>4096&&!settled){settled=true;reject(Error('OBSERVATION_OVERSIZE'));}});
  p.on('error',()=>{clearTimeout(timer);if(!settled){settled=true;reject(Error('OBSERVATION_FAILED'));}});
  p.on('close',code=>{clearTimeout(timer);if(settled)return;settled=true;try{if(code!==0)throw Error();resolve(JSON.parse(text));}catch{reject(Error('OBSERVATION_FAILED'));}});
 });
}
async function health(service,ms=3000){
 const setting=profile[service],headers={};
 if(service==='backend')headers.Authorization='Bearer '+fs.readFileSync(setting.apiKeyFile,'utf8').trim();
 try{
  const r=await fetch('http://127.0.0.1:'+setting.port+'/health',{headers,signal:AbortSignal.timeout(Math.max(1,Math.floor(ms)))});
  if(r.status===401||r.status===403)throw Error('AUTHENTICATION_BLOCKED');
  if(!r.ok)return false;const text=await r.text();if(text.length>4096)return false;const b=JSON.parse(text);
  return b.status==='ok'&&(service==='backend'||b.backend==='chatbot-ui');
 }catch(e){if(e.message==='AUTHENTICATION_BLOCKED')throw e;return false;}
}
function checkGate(){
 const q=JSON.parse(fs.readFileSync(path.join(root,'qualification.json'),'utf8'));
 if(q.activationApproved!==true||q.modelLoadPassed!==true||q.generationPassed!==true||
 q.databaseStartupApproved!==true||q.gracefulBackendStopPassed!==true||q.gracefulNodeStopPassed!==true||q.gpuUUID!==profile.gpuUUID)throw Error('QUALIFICATION_INCOMPLETE');
 for(const service of ['backend','application']){
  const dir=path.join(root,'build',service),m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  const expected=service==='backend'?require('C:/AI/chatbot-ui/core/llama-launch.js').buildLlamaLaunchSpec(profile.backend):profile.application; if(m.profile.executable!==expected.executable||m.profile.cwd!==expected.cwd||JSON.stringify(m.profile.args)!==JSON.stringify(expected.args))throw Error('COMPILED_PROFILE_MISMATCH');
  if(m.profile.operatorSid!==profile.sid)throw Error('COMPILED_IDENTITY_MISMATCH');
  if(hash(path.join(dir,'broker.exe'))!==m.broker)throw Error('BROKER_HASH');
  for(const pin of m.pins)if(hash(pin.path)!==pin.sha256)throw Error('DEPENDENCY_HASH');
 }
}
async function main(testProviders){
 // CLI never supplies providers. This seam executes the same coordinator with isolated effects.
 const effects=testProviders||{};
 const gate=effects.gate||checkGate,observe=effects.observe||runObserver,connect=effects.connect||open;
 const healthy=effects.health||health,log=effects.log||fixedLog;
 const clock=effects.now||(()=>performance.now()),pause=effects.pause||sleep;
 const io=effects.fs||fs,mode=effects.mode||process.argv[2];

 if(mode==='--status'){
  let record={state:'inactive'};try{record=JSON.parse(io.readFileSync(path.join(state,'status.json'),'utf8'));}catch{}
  console.log(JSON.stringify({record,leasePresent:io.existsSync(path.join(state,'supervisor.lease'))}));return;
 }
 if(mode==='--stop'){
  // No PID-based action. Only the running owner consumes this request.
  if(!io.existsSync(path.join(state,'supervisor.lease')))throw Error('NO_OWNER');
  io.writeFileSync(path.join(state,'stop.request'),'stop\n',{flag:'wx'});return;
 }
 if(mode!=='--run')throw Error('MODE_REQUIRED');
 gate(); if(!(await observe('environment')).environmentVerified)throw Error('ENVIRONMENT_BLOCKED');
 const lease=path.join(state,'supervisor.lease'),fd=io.openSync(lease,'wx');
 io.writeSync(fd,'unresolved supervisor session\n');io.fsyncSync(fd);
 const owned=new Map(),external=new Map(),recoveries=new Map(),failures=new Map();
 let clean=false,stopRequested=false;
 const stopping=()=>stopRequested||io.existsSync(path.join(state,'stop.request'));
 async function backoff(ms){const end=clock()+ms;while(clock()<end&&!stopping())await pause(Math.min(200,end-clock()));}
 const onStop=()=>{stopRequested=true;};
 process.on('SIGINT',onStop);process.on('SIGTERM',onStop);
 async function ensure(service){
  const observation=await observe(service);
  if(classify(observation)==='external'){
   if(!await healthy(service))throw Error('EXTERNAL_UNHEALTHY');
   external.set(service,observation);log('external-preserved',service);return;
  }
  if(!(await observe('environment')).environmentVerified)throw Error('ENVIRONMENT_BLOCKED');
  const dir=path.join(root,'build',service),client=await connect(path.join(dir,'broker.exe'),dir);
  owned.set(service,client);recoveries.set(service,recoveries.get(service)||budget(()=>Math.floor(clock())));
  const end=clock()+TIMEOUTS.startupMs;
  await client.request('START',{timeoutMs:end-clock()});
  const outcome=await waitReady({observe:ms=>client.request('STATUS',{timeoutMs:ms}),health:ms=>healthy(service,ms),
   now:()=>clock(),pause,end,cancelled:()=>stopRequested||io.existsSync(path.join(state,'stop.request')),gpu:service==='backend'});
  if(outcome.exited){
   const delay=recoveries.get(service).next({process:'exited',streamsClosed:outcome.exited.streamsClosed,listenerReleased:outcome.exited.listenerReleased});
   await client.request('QUIT');owned.delete(service);
   if(delay===null)throw Error('RECOVERY_EXHAUSTED');
   await backoff(delay);
   if(stopRequested||io.existsSync(path.join(state,'stop.request')))throw Error('START_CANCELLED');
   return ensure(service);
  }
  log('ready',service);
 }
 async function stopOwned(){
  for(const service of ['application','backend']){
   const b=owned.get(service);if(!b)continue;
   recoveries.get(service)?.suppress();
   const r=await b.request('STOP');
   if(!['exited','graceful-complete'].includes(r.status))return false;
   await b.request('QUIT');owned.delete(service);
  }
  return true;
 }
 try{
  // Existing application never enters owned. Backend must be ready before a new application starts.
  const app=await observe('application');
  if(classify(app)==='external'){if(!await healthy('application'))throw Error('EXTERNAL_UNHEALTHY');external.set('application',app);}
  await ensure('backend');
  if(!external.has('application'))await ensure('application');
  while(true){
   if(stopRequested||io.existsSync(path.join(state,'stop.request'))){
    if(await stopOwned()){clean=true;break;}
    log('shutdown-incomplete','owned');await pause(1000);continue;
   }
   for(const [service,b] of owned){
    const s=await b.request('STATUS');
    if(s.status==='exited'){
     const delay=recoveries.get(service).next({process:'exited',streamsClosed:s.streamsClosed,listenerReleased:s.listenerReleased});
     await b.request('QUIT');owned.delete(service);
     if(delay===null)throw Error('RECOVERY_EXHAUSTED');
     log('recovery-backoff',service);await backoff(delay);
     if(!stopRequested&&!io.existsSync(path.join(state,'stop.request')))await ensure(service);
    }else if(s.status==='owned'){
     const ok=s.listener&&await healthy(service);
     failures.set(service,ok?0:(failures.get(service)||0)+1);
     if(failures.get(service)>=3)log('unhealthy-live-no-restart',service);
    }else if(s.status!=='exit-pending')throw Error('OWNERSHIP_LOST');
   }
   for(const [service,old] of external){
    const current=await observe(service);
    if(current.state!=='external'||current.pid!==old.pid||current.created!==old.created)throw Error('EXTERNAL_IDENTITY_CHANGED');
    if(!await healthy(service))log('external-unhealthy-preserved',service);
   }
   io.writeFileSync(path.join(state,'status.json'),JSON.stringify({at:new Date().toISOString(),state:'monitoring',owned:[...owned.keys()],external:[...external.keys()]}));
   await pause(1000);
  }
 }catch{
  log('blocked-preserving-live-services','supervisor');
  // Remain owner for manual cooperative stop. Never automatically kill/restart a living child.
  while(owned.size){
   if(stopRequested||io.existsSync(path.join(state,'stop.request'))){try{if(await stopOwned()){clean=true;break;}}catch{}}
   await pause(1000);
  }
 }finally{
  process.removeListener('SIGINT',onStop);process.removeListener('SIGTERM',onStop);
  io.closeSync(fd);
  if(clean){io.unlinkSync(lease);if(io.existsSync(path.join(state,'stop.request')))io.unlinkSync(path.join(state,'stop.request'));}
 }
}
if(require.main===module)main().catch(()=>{console.error('STARTUP_BLOCKED');process.exitCode=2;});
module.exports={checkGate,health,runObserver,main};
