'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWindowsBackendLifecycle,STATES}=require('../core/windows-backend-lifecycle');

const owned=(pid=42)=>({state:'verified',pid,createdAt:'2026-11-09T10:00:00.0000000Z',listener:{host:'127.0.0.1',port:8080,owningPid:pid}});
function harness({observe,effects,assess,readinessTimeoutMs=5000}={}){
 let running=false,pid=null;
 const calls={launch:0,stop:0};
 const backend=createWindowsBackendLifecycle({
  observe:observe||(async()=>running?owned(pid):{state:'absent'}),
  effects:effects||{launch:async()=>{calls.launch++;running=true;pid=42;},stop:async()=>{calls.stop++;running=false;pid=null;}},
  assess,readinessTimeoutMs
 });
 return {backend,calls};
}

test('verified start from stopped state',async()=>{
 const h=harness();
 const r=await h.backend.start();
 assert.equal(r.status,STATES.ready);assert.equal(r.reason,'verified-start');assert.equal(h.calls.launch,1);assert.equal(h.backend.getState(),STATES.ready);
});
test('verified stop of an owned process',async()=>{
 const h=harness();await h.backend.start();
 const r=await h.backend.stop();
 assert.equal(r.status,STATES.stopped);assert.equal(r.reason,'verified-stop');assert.equal(h.calls.stop,1);assert.equal(h.backend.getState(),STATES.stopped);
});
test('verified restart of an owned process',async()=>{
 const h=harness();await h.backend.start();
 const r=await h.backend.restart();
 assert.equal(r.status,STATES.ready);assert.equal(r.reason,'verified-restart');assert.equal(h.calls.launch,2);assert.equal(h.calls.stop,1);
});
test('ambiguous evidence rejects start without effects',async()=>{
 let stopCalls=0;
 const h=harness({observe:async()=>({state:'unverifiable',reason:'ambiguous'}),effects:{launch:async()=>{},stop:async()=>{stopCalls++;}}});
 const r=await h.backend.start();
 assert.equal(r.status,STATES.ownershipUncertain);assert.equal(r.code,'EVIDENCE_INSUFFICIENT');assert.equal(stopCalls,0);
});
test('ownership change between inspection and effect blocks termination',async()=>{
 let observeFn=async()=>({state:'absent'});
 let stopCalls=0;
 const backend=createWindowsBackendLifecycle({observe:()=>observeFn(),effects:{launch:async()=>{observeFn=async()=>owned(42);},stop:async()=>{stopCalls++;observeFn=async()=>({state:'absent'});}}});
 await backend.start();
 const values=[owned(42),owned(43)];
 let i=0;observeFn=async()=>values[Math.min(i++,values.length-1)];
 const r=await backend.stop();
 assert.equal(r.status,STATES.ownershipUncertain);assert.equal(r.code,'OWNERSHIP_CHANGED');assert.equal(stopCalls,0);
});
test('concurrent lifecycle requests are rejected',async()=>{
 const h=harness();
 const first=h.backend.start();
 const second=h.backend.start();
 assert.equal((await second).code,'BUSY');
 await first;
});
test('readiness timeout fails closed without termination effects',async()=>{
 let stopCalls=0;
 const h=harness({readinessTimeoutMs:20,effects:{launch:async()=>{},stop:async()=>{stopCalls++;}}});
 const r=await h.backend.start();
 assert.equal(r.status,STATES.failed);assert.equal(r.code,'READINESS_TIMEOUT');assert.equal(stopCalls,0);
});
