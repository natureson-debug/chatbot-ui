'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,createWatchdogStatus}=require('../core/watchdog-status');
const {createWatchdogStatusRoute}=require('../core/watchdog-status-route');
const raw=()=>({task:{state:'Disabled',enabled:false,lastRun:'2026-11-12T00:00:00Z',nextRun:null,lastResult:0},backend:{verified:true,configurationMatched:true,pid:100,reason:'verified'},marker:'absent',log:{updatedAt:'2026-11-12T00:00:00Z',malformed:false,observations:[{state:'healthy',reason:'health-healthy',recoveryAttempted:false}]}});
test('normalization allowlists evidence and bounds history, labels old log',()=>{
    const r=raw();r.secret='sensitive';r.backend.commandLine='sensitive';r.log.observations=Array(20).fill(r.log.observations[0]);
    r.log.observations.push({state:'healthy',reason:'sensitive',recoveryAttempted:false});
    const v=normalize(r,Date.parse('2026-11-12T00:10:00Z'));
    assert.equal(v.task.lastResult,0);assert.equal(v.backend.pid,100);assert(v.log.stale);assert(v.log.malformed);assert(v.log.observations.length<=12);assert(!JSON.stringify(v).includes('sensitive'));
    assert.equal(normalize({task:{state:'bogus'},backend:{verified:true},marker:'bogus'},0).task,null);
});
test('normalization distinguishes task errors, unavailable evidence, and verified mismatch',()=>{
    for(const reason of ['task-access-denied','task-not-found','task-unavailable']){
        const v=normalize({task:null,taskReason:reason,backend:{verified:false,configurationMatched:false,pid:100,reason:'evidence-unavailable'},observedListenerPid:100},0);
        assert.equal(v.taskReason,reason);assert.deepEqual(v.backend,{verified:null,configurationMatched:null,pid:null,reason:'evidence-unavailable'});assert.equal(v.observedListenerPid,100);
    }
    const mismatch=normalize({backend:{verified:true,configurationMatched:false,pid:100,reason:'configuration-mismatch'}},0);
    assert.deepEqual(mismatch.backend,{verified:true,configurationMatched:false,pid:100,reason:'configuration-mismatch'});
    for(const backend of [
        {verified:false,configurationMatched:false,pid:100,reason:'configuration-mismatch'},
        {verified:true,configurationMatched:false,pid:100,reason:'evidence-unavailable'},
        {verified:true,configurationMatched:false,pid:null,reason:'configuration-mismatch'},
        {verified:true,configurationMatched:true,pid:100,reason:'synthetic-private'}
    ]){
        const v=normalize({backend,taskReason:'synthetic-private',observedListenerPid:-1},0);
        assert.equal(v.backend.verified,null);assert.equal(v.backend.configurationMatched,null);assert.equal(v.backend.pid,null);
        assert.equal(v.taskReason,'task-unavailable');assert.equal(v.observedListenerPid,null);assert(!JSON.stringify(v).includes('synthetic-private'));
    }
});
test('cache coalesces requests and expires without stale fallback on failure',async()=>{
    let clock=0,calls=0,release,fail=false;
    const sample=createWatchdogStatus({platform:'win32',now:()=>clock,collect:async()=>{calls++;if(fail)throw Error('sensitive');await new Promise(r=>release=r);return raw();}});
    const a=sample(),b=sample();release();await Promise.all([a,b]);assert.equal(calls,1);
    await sample();assert.equal(calls,1);clock=16000;fail=true;const v=await sample();assert.equal(calls,2);assert.equal(v.availability,'unavailable');assert.equal(v.backend,null);assert(!JSON.stringify(v).includes('sensitive'));
});
test('unsupported platforms never collect',async()=>{
    let called=false;const sample=createWatchdogStatus({platform:'darwin',collect:()=>{called=true;}});
    assert.equal((await sample()).availability,'unsupported');assert(!called);
});
function response(){return {writeHead(code,headers){this.code=code;this.headers=headers;},end(body){this.body=JSON.parse(body);}};}
test('route denies anonymous/nonadmin before sampling and blocks writes',async()=>{
    for(const user of [null,{id:'u',is_admin:0}]){
        let sampled=false;const route=createWatchdogStatusRoute({token:()=>null,authenticate:()=>user,sample:()=>{sampled=true;}}),res=response();
        await route({method:'GET',url:'/api/admin/watchdog/status'},res);assert.equal(res.code,user?403:401);assert(!sampled);
    }
    const route=createWatchdogStatusRoute({token:()=>'',authenticate:()=>({id:'a',is_admin:1}),sample:()=>{throw Error('must not sample');}}),res=response();
    await route({method:'POST',url:'/api/admin/watchdog/status'},res);assert.equal(res.code,405);
});
test('route revalidates original session after collection',async()=>{
    for(const revoked of [false,true]){
        let user={id:'a',is_admin:1};const tokens=[];
        const route=createWatchdogStatusRoute({token:()=> 'original',authenticate:t=>{tokens.push(t);return user;},sample:async()=>{if(revoked)user=null;return {fixture:true};}}),res=response();
        await route({method:'GET',url:'/api/admin/watchdog/status'},res);
        assert.equal(res.code,revoked?401:200);assert.deepEqual(tokens,['original','original']);assert.equal(res.headers['Cache-Control'],'no-store');
    }
});
const {createWatchdogMonitor}=require('../public/admin-watchdog');
class Node {constructor(){this.children=[];this.textContent='';}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(){}}
function ui(fetch){const host=new Node(),listeners={},timers=new Map();let id=0;const document={hidden:false,getElementById:()=>host,createElement:()=>new Node(),addEventListener:(n,f)=>listeners[n]=f,removeEventListener:n=>delete listeners[n]};const monitor=createWatchdogMonitor({document,fetch,now:()=>Date.parse('2026-11-12T00:10:00Z'),setTimer:(f,ms)=>{timers.set(++id,{f,ms});return id;},clearTimer:id=>timers.delete(id)});return {host,document,listeners,timers,monitor};}
const text=n=>n.textContent+n.children.map(text).join(' ');
test('UI renders bounded real values and stale/untimed log labels',async()=>{
    const f=ui(async()=>({ok:true,json:async()=>normalize(raw(),Date.parse('2026-11-12T00:00:00Z'))}));await f.monitor.poll();const output=text(f.host);
    assert(output.includes('Disabled'));assert(output.includes('100'));assert(output.includes('Stale snapshot'));assert(output.includes('no individual timestamps'));
    assert([...f.timers.values()].some(t=>t.ms===15000));f.monitor.dispose();assert.equal(f.timers.size,0);
});
test('UI labels inaccessible evidence and listener observation without claiming a mismatch',async()=>{
    for(const [reason,label] of [['task-access-denied','Unavailable (access denied)'],['task-not-found','Not found']]){
        const sample=normalize({taskReason:reason,backend:{verified:false,configurationMatched:false,reason:'evidence-unavailable'},observedListenerPid:100},Date.parse('2026-11-12T00:10:00Z'));
        const f=ui(async()=>({ok:true,json:async()=>({...sample,availability:'observed'})}));await f.monitor.poll();
        const output=text(f.host);assert(output.includes('Partial snapshot.'));assert(output.includes(`Task: ${label}`));assert(output.includes('Backend PID: Unavailable'));
        assert(output.includes('Observed listener PID (Unverified): 100'));assert(output.includes('Saved configuration: Unavailable (not verified)'));assert(!output.includes('Mismatch'));f.monitor.dispose();
    }
});
test('UI displays mismatch only for a verified comparison',async()=>{
    const sample=normalize({backend:{verified:true,configurationMatched:false,pid:100,reason:'configuration-mismatch'}},Date.parse('2026-11-12T00:10:00Z'));
    const f=ui(async()=>({ok:true,json:async()=>({...sample,availability:'observed'})}));await f.monitor.poll();
    const output=text(f.host);assert(output.includes('Backend PID: 100'));assert(output.includes('Backend ownership: Verified observation'));assert(output.includes('Saved configuration: Mismatch (verified comparison)'));f.monitor.dispose();
});
test('UI coalesces polls, aborts hidden polling and discards late results',async()=>{
    let release,calls=0,signal;
    const g=ui(async(_url,options)=>{calls++;signal=options.signal;await new Promise(r=>release=r);return {ok:true,json:async()=>normalize(raw(),Date.now())};});
    const pending=g.monitor.poll();await g.monitor.poll();assert.equal(calls,1);g.document.hidden=true;g.listeners.visibilitychange();assert(signal.aborted);release();await pending;assert.equal(g.timers.size,0);assert(!text(g.host).includes('Backend PID: 100'));g.monitor.dispose();
});
test('UI clears data and stops on authorization failure',async()=>{
    const f=ui(async()=>({ok:false,status:401}));f.document.hidden=true;await f.monitor.poll();assert.equal(f.timers.size,0);f.document.hidden=false;await f.monitor.poll();assert(text(f.host).includes('Administrator session required'));assert.equal(f.timers.size,0);f.monitor.dispose();
});
