const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTestLifecyclePolicy,DEFAULTS}=require('../core/lifecycle-policy');
function fixture(policy={}) {
    let time=0, sequence=0;const handle={};
    const engine=createTestLifecyclePolicy({mode:'TEST',now:()=>time,policy});
    const evidence=(extra={})=>({complete:true,stable:true,observedAt:time,sequence:++sequence,
        process:'absent',listener:'absent',...extra});
    const owned=(extra={})=>evidence({process:'alive',listener:'owned',identityVerified:true,retainedHandle:handle,health:'ok',...extra});
    const call=(type,o=evidence(),extra={})=>engine.dispatch({type,...extra},o);
    const attach=()=>engine.dispatch({type:'launched',operationId:engine.snapshot().operationId,retainedHandle:handle,identityVerified:true});
    const start=()=>{const r=call('start');assert.equal(r.effects[0].type,'simulate-launch');attach();assert.equal(call('observe',owned()).state,'ready');};
    const exit=()=>owned({process:'exited',listener:'absent'});
    return {engine,evidence,owned,call,attach,start,exit,handle,advance:n=>time+=n};
}
test('TEST restriction and policy defaults',()=>{
    assert.throws(()=>createTestLifecyclePolicy({now:()=>0}));
    assert.equal(DEFAULTS.startupMs,300000);assert.equal(DEFAULTS.autoRecovery,false);
    for(const p of [{startupMs:0},{healthFailures:-1},{backoffMs:[]},{autoRecovery:'yes'},{unknown:1}])assert.throws(()=>fixture(p));
});
test('successful start, clean stop and persistent operation outcomes',()=>{
    const f=fixture();f.start();const id=f.engine.snapshot().operationId;assert(id);
    const stop=f.call('stop',f.owned());assert.equal(stop.effects[0].type,'simulate-clean-stop');
    const done=f.call('observe',f.exit());assert.equal(done.state,'stopped');assert.equal(done.diagnostics.shutdown,'clean-complete');assert.notEqual(done.operationId,id);
});
test('start/stop/restart races reject contenders without effects',()=>{
    const f=fixture();const initial=f.call('start');
    for(const type of ['start','stop','restart']){const r=f.call(type);assert.equal(r.outcome,'busy');assert.equal(r.effects.length,0);assert.equal(r.operationId,initial.operationId)}
    f.attach();f.call('observe',f.owned());f.call('restart',f.owned());assert.equal(f.call('start',f.owned()).outcome,'busy');
});
test('restart does not launch before both exit and listener release',()=>{
    const f=fixture();f.start();f.call('restart',f.owned());
    assert.equal(f.call('observe',f.owned({listener:'absent'})).effects.length,0);
    const r=f.call('observe',f.exit());assert.equal(r.state,'starting');assert.equal(r.effects[0].type,'simulate-launch');
});
test('foreign listeners, unowned PID-only processes and changed handle block',()=>{
    for(const ob of [{listener:'foreign'},{process:'alive',pid:123,executable:'llama-server.exe'}]){
        const f=fixture();const r=f.call('start',f.evidence(ob));assert.equal(r.state,'blocked');assert.equal(r.effects.length,0);
    }
    const f=fixture();f.start();const r=f.call('stop',f.owned({retainedHandle:{}}));assert.equal(r.state,'blocked');assert.equal(r.effects.length,0);
});
test('stale, future, incomplete and replayed observations block',()=>{
    for(const ob of [{complete:false},{stable:false},{observedAt:1},{sequence:-1}]){const f=fixture();assert.equal(f.call('start',f.evidence(ob)).state,'blocked')}
    const f=fixture();f.start();const o=f.owned();f.call('observe',o);assert.equal(f.call('observe',o).state,'blocked');
    const g=fixture();g.advance(3000);assert.equal(g.call('start',g.evidence({observedAt:0})).state,'blocked');
});
test('unresolved launch timeout blocks without launching again',()=>{
    const f=fixture({startupMs:10});f.call('start');f.advance(10);const r=f.call('tick');assert.equal(r.state,'blocked');assert.equal(r.effects.length,0);
});
test('retained startup timeout fails without relinquishing handle',()=>{
    const f=fixture({startupMs:10});f.call('start');f.attach();f.advance(10);
    const r=f.call('tick',f.owned({health:'retryable-failure'}));assert.equal(r.state,'failed');assert.equal(r.diagnostics.owned,true);
    assert.equal(f.call('stop',f.owned()).effects[0].type,'simulate-clean-stop');
});
test('late launch result cannot bypass deadline and stale operation cannot attach',()=>{
    const f=fixture({startupMs:10});f.call('start');assert.equal(f.engine.dispatch({type:'launched',operationId:'wrong',retainedHandle:{},identityVerified:true}).outcome,'rejected');
    f.advance(10);assert.equal(f.attach().state,'failed');
});
test('three consecutive failures; good health resets threshold; recovery default off',()=>{
    const f=fixture();f.start();f.call('observe',f.owned({health:'retryable-failure'}));assert.equal(f.call('observe',f.owned()).state,'ready');
    for(let i=0;i<2;i++)assert.equal(f.call('observe',f.owned({health:'retryable-failure'})).state,'degraded');
    const r=f.call('observe',f.owned({health:'retryable-failure'}));assert.equal(r.state,'failed');assert.equal(r.effects.length,0);
});
test('automatic health recovery first stops and verifies release, then backoff',()=>{
    const f=fixture({autoRecovery:true,healthFailures:1});f.start();
    assert.equal(f.call('observe',f.owned({health:'retryable-failure'})).effects[0].type,'simulate-clean-stop');
    assert.equal(f.call('observe',f.exit()).state,'backoff');
    f.advance(4999);assert.equal(f.call('tick').effects.length,0);f.advance(1);assert.equal(f.call('tick').effects[0].type,'simulate-launch');
});
test('recovery budget limits launches to three and uses 5/15/60 second backoff',()=>{
    const f=fixture({autoRecovery:true});f.start();
    for(const delay of [5000,15000,60000]){
        const r=f.call('observe',f.exit());assert.equal(r.state,'backoff');f.advance(delay-1);assert.equal(f.call('tick').effects.length,0);
        f.advance(1);assert.equal(f.call('tick').effects[0].type,'simulate-launch');f.attach();f.call('observe',f.owned());
    }
    const r=f.call('observe',f.exit());assert.equal(r.state,'failed');assert.equal(r.reason,'recovery-budget-exhausted');
});
test('deliberate stop cancels backoff and suppresses recovery',()=>{
    const f=fixture({autoRecovery:true});f.start();f.call('observe',f.exit());assert.equal(f.call('stop').state,'stopped');
    f.advance(60000);assert.equal(f.call('tick').effects.length,0);assert.equal(f.engine.snapshot().diagnostics.recoverySuppressed,true);
});
test('shutdown timeout retains operation; forced eligibility requires approval and exact handle',()=>{
    const f=fixture({shutdownMs:10});f.start();const r=f.call('stop',f.owned());f.advance(10);
    const timeout=f.call('tick',f.owned());assert.equal(timeout.diagnostics.shutdown,'incomplete');
    assert.equal(f.call('restart',f.owned()).outcome,'busy');
    assert.equal(f.call('force-stop',f.owned(),{operationId:r.operationId}).effects.length,0);
    assert.equal(f.call('force-stop',f.owned(),{operationId:r.operationId,approved:true}).effects[0].type,'simulate-force-stop');
    assert.equal(f.call('observe',f.exit()).diagnostics.shutdown,'forced-complete');
});
test('cancellation never implicitly kills a process or authorizes retry',()=>{
    const f=fixture();const r=f.call('start');const cancelled=f.call('cancel',undefined,{operationId:r.operationId});
    assert.equal(cancelled.state,'blocked');assert.equal(cancelled.effects.length,0);
    const g=fixture();g.call('start');g.attach();const c=g.call('cancel',undefined,{operationId:g.engine.snapshot().operationId});assert.equal(c.state,'failed');assert.equal(c.diagnostics.recoverySuppressed,true);
});
test('auth/config/security failures are nonretryable and diagnostics exclude provider secrets',()=>{
    for(const failure of ['authentication','configuration','security']){
        const f=fixture({autoRecovery:true});f.start();const r=f.call('observe',f.owned({failure,error:'secret-api-key'}));assert.equal(r.state,'blocked');assert.equal(r.effects.length,0);assert(!JSON.stringify(r).includes('secret-api-key'));
    }
});
test('clock failures fail closed',()=>{const f=fixture();f.advance(100);f.call('start');f.advance(-1);assert.equal(f.call('tick').state,'blocked')});
test('rolling budget expires without resetting configuration or healthy state',()=>{
    const f=fixture({autoRecovery:true,recoveryLaunches:1,recoveryWindowMs:100,backoffMs:[5]});f.start();
    f.call('observe',f.exit());f.advance(5);f.call('tick');f.attach();f.call('observe',f.owned());
    f.advance(100);assert.equal(f.call('observe',f.exit()).state,'backoff');f.advance(5);
    assert.equal(f.call('tick').effects[0].type,'simulate-launch');
});
test('security failure before launch and listener remaining after exit block all effects',()=>{
    const f=fixture();assert.equal(f.call('start',f.evidence({failure:'security'})).state,'blocked');
    const g=fixture();g.start();g.call('restart',g.owned());const r=g.call('observe',g.exit());
    // A new launch is emitted only with absent listener; test contradictory exit independently.
    assert.equal(r.effects.length,1);
    const h=fixture();h.start();h.call('restart',h.owned());const b=h.call('observe',h.owned({process:'exited'}));
    assert.equal(b.state,'blocked');assert.equal(b.effects.length,0);
});
test('spec construction and runtime are never imported by policy',()=>{
    const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');const m={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../core/lifecycle-policy.js'),'utf8'),{module:m,require(){throw Error('I/O forbidden')}});
    const e=m.exports.createTestLifecyclePolicy({mode:'TEST',now:()=>0});assert.equal(e.snapshot().state,'stopped');
});
