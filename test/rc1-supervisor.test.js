'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {attach}=require('../release/rc1/supervisor/broker-client.cjs');
const {TIMEOUTS}=require('../release/rc1/supervisor/timeouts.cjs');
const {bootTask}=require('../release/rc1/supervisor/boot-task.cjs');
function fixture(){
 const p=new EventEmitter();p.pid=123;p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.stdin=new EventEmitter();
 const writes=[],timers=new Map();let id=0;
 p.stdin.write=x=>writes.push(x);p.stdin.end=()=>{};
 const ready=attach(p,{setTimer:(f,ms)=>{timers.set(++id,{f,ms});return id;},clearTimer:i=>timers.delete(i)});
 const frame=x=>p.stdout.emit('data',Buffer.from(JSON.stringify(x)+'\n'));
 frame({version:1,nonElevated:true,token:'a'.repeat(32)});
 return {p,ready,writes,timers,frame};
}
test('candidate broker serializes commands and validates sequence',async()=>{
 const f=fixture(),b=await f.ready,p=b.request('STATUS');await assert.rejects(b.request('START'),/INVALID_CONTROL/);
 f.frame({status:'owned',nextSequence:2});assert.equal((await p).status,'owned');assert.equal(f.writes.length,1);
});
test('candidate timeout permanently poisons late responses without another launch',async()=>{
 const f=fixture(),b=await f.ready,p=b.request('START');const rejection=assert.rejects(p,/UNVERIFIABLE/);
 [...f.timers.values()][0].f();await rejection;f.frame({status:'owned',nextSequence:2});
 await assert.rejects(b.request('START'),/UNVERIFIABLE/);assert.equal(f.writes.length,1);
});
test('candidate malformed reply revokes channel',async()=>{
 const f=fixture(),b=await f.ready,p=b.request('STATUS');f.p.stdout.emit('data',Buffer.from('invalid\n'));await assert.rejects(p);
 await assert.rejects(b.request('STOP'));assert.equal(f.writes.length,1);
});
test('candidate wrong sequence revokes channel',async()=>{
 const f=fixture(),b=await f.ready,p=b.request('STATUS');f.frame({status:'owned',nextSequence:99});await assert.rejects(p);await assert.rejects(b.request('START'));
});
test('candidate unsolicited reply revokes channel',async()=>{
 const f=fixture(),b=await f.ready;f.frame({status:'owned',nextSequence:2});await assert.rejects(b.request('START'));assert.equal(f.writes.length,0);
});
test('candidate QUIT waits for close, not process exit',async()=>{
 const f=fixture(),b=await f.ready;let done=false;const p=b.request('QUIT').then(()=>{done=true;});f.p.emit('exit',0);await Promise.resolve();assert.equal(done,false);f.p.emit('close',0);await p;assert.equal(done,true);
});
test('candidate STOP deadline exceeds native and application deadlines',async()=>{
 assert(TIMEOUTS.nativeStopMs>20000);assert(TIMEOUTS.stopReplyMs>TIMEOUTS.nativeStopMs);
 const f=fixture(),b=await f.ready,p=b.request('STOP');assert.equal([...f.timers.values()][0].ms,35000);f.frame({status:'incomplete',nextSequence:2});assert.equal((await p).status,'incomplete');
});
test('candidate remaining startup budget bounds request and prevents expired command',async()=>{
 const f=fixture(),b=await f.ready;await assert.rejects(b.request('START',{timeoutMs:0}));assert.equal(f.writes.length,0);
 const p=b.request('STATUS',{timeoutMs:75});assert.equal([...f.timers.values()][0].ms,75);f.frame({status:'owned',nextSequence:2});await p;
});
test('candidate write failure is sanitized and does not retry',async()=>{
 const f=fixture(),b=await f.ready;f.p.stdin.write=()=>{throw Error('secret');};await assert.rejects(b.request('START'),e=>e.message==='BROKER_UNVERIFIABLE');await assert.rejects(b.request('START'));
});
test('candidate boot definition is disabled noninteractive least privilege without hard termination',()=>{
 const xml=bootTask({sid:'S-1-5-21-1-2-3-1001',node:'C:\\Program Files\\nodejs\\node.exe',supervisor:'C:\\Protected\\supervisor.cjs',cwd:'C:\\Protected',delaySeconds:45});
 for(const s of ['<BootTrigger>','<LogonType>Password</LogonType>','<RunLevel>LeastPrivilege</RunLevel>','<Enabled>false</Enabled>','<AllowHardTerminate>false</AllowHardTerminate>','<Delay>PT45S</Delay>','IgnoreNew'])assert(xml.includes(s));
 assert(!xml.includes('LogonTrigger'));assert(!xml.includes('RestartOnFailure'));
});
test('candidate boot generator rejects SYSTEM, relative path and invalid delay',()=>{
 const a={sid:'S-1-5-21-1-2-3-1001',node:'C:\\node.exe',supervisor:'C:\\supervisor.cjs',cwd:'C:\\Protected'};
 assert.throws(()=>bootTask({...a,sid:'S-1-5-18'}));assert.throws(()=>bootTask({...a,node:'node.exe'}));assert.throws(()=>bootTask({...a,delaySeconds:-1}));
});
const {main,checkGate}=require('../release/rc1/supervisor/supervisor.cjs');
async function simulation({fail,crash,external=false,conflict=false,stale=false,cancelBackoff=false}={}){
 let t=0,stop=false,leased=stale,pauses=0;const calls=[],logs=[],counts={};
 const effects={mode:'--run',gate(){},now:()=>t,health:async()=>true,log:(...x)=>logs.push(x),
 fs:{existsSync:p=>p.endsWith('stop.request')?stop:leased,openSync(){if(leased)throw Error('EEXIST');leased=true;return 1;},writeSync(){},fsyncSync(){},closeSync(){},unlinkSync:p=>{if(p.endsWith('supervisor.lease'))leased=false;},writeFileSync(){}},
 observe:async s=>s==='environment'?{environmentVerified:true}:conflict?{state:'conflict'}:external&&s==='application'?{state:'external',pid:1,created:'fixed',identityObserved:true}:{state:'absent'},
 pause:async ms=>{t+=ms;if(++pauses>1000)throw Error('TEST_HANG');if(cancelBackoff||t>=90000||(!fail&&!crash))stop=true;},
 connect:async(exe,dir)=>{const service=dir.endsWith('backend')?'backend':'application',attempt=counts[service]=(counts[service]||0)+1;let statuses=0;
 return {request:async command=>{calls.push([service,command]);
 if(command==='STATUS'){
 statuses++;if(fail===service||crash===service&&statuses>1&&attempt===1)return {status:'exited',streamsClosed:true,listenerReleased:true};
 return {status:'owned',listener:true,offloaded:37,totalLayers:37,cudaModel:true,cudaKV:true};}
 if(command==='STOP')return {status:'graceful-complete'};return {status:'owned'};}};}
 };
 await main(effects);return {calls,logs,counts,leased,t};
}
test('candidate qualification gate remains closed',()=>assert.throws(checkGate,/QUALIFICATION_INCOMPLETE/));
test('actual coordinator starts backend before app and stops app first',async()=>{
 const r=await simulation();assert.deepEqual(r.calls.filter(x=>x[1]==='START').map(x=>x[0]),['backend','application']);assert.deepEqual(r.calls.filter(x=>x[1]==='STOP').map(x=>x[0]),['application','backend']);assert.equal(r.leased,false);
});
for(const service of ['backend','application']){
 test('actual coordinator bounds repeated '+service+' startup failure',async()=>{const r=await simulation({fail:service});assert.equal(r.counts[service],4);assert(r.logs.some(x=>x[0]==='blocked-preserving-live-services'));if(service==='backend')assert(!r.counts.application);});
 test('actual coordinator recovers verified '+service+' exit',async()=>{const r=await simulation({crash:service});assert.equal(r.counts[service],2);assert.equal(r.leased,false);});
}
test('actual coordinator never owns or stops existing application',async()=>{const r=await simulation({external:true});assert(!r.calls.some(x=>x[0]==='application'));});
test('actual coordinator rejects conflict without a launch',async()=>{const r=await simulation({conflict:true});assert.equal(r.calls.length,0);assert.equal(r.leased,true);});
test('actual coordinator stale installation lease blocks before any connection',async()=>{await assert.rejects(simulation({stale:true}),/EEXIST/);});
test('actual coordinator stop during recovery cancels before replacement',async()=>{const r=await simulation({fail:'backend',cancelBackoff:true});assert.equal(r.counts.backend,1);assert(r.t<=200);});
