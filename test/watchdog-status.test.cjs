'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalize,createWatchdogStatus}=require('../core/watchdog-status');
const {createWatchdogStatusRoute}=require('../core/watchdog-status-route');
const raw=()=>({task:{state:'Disabled',enabled:false,lastRun:'2026-11-12T00:00:00Z',nextRun:null,lastResult:0},backend:{verified:true,configurationMatched:true,pid:100},marker:'absent',log:{updatedAt:'2026-11-12T00:00:00Z',malformed:false,observations:[{state:'healthy',reason:'health-healthy',recoveryAttempted:false}]}});
test('normalization allowlists evidence and bounds history, labels old log',()=>{
    const r=raw();r.secret='sensitive';r.backend.commandLine='sensitive';r.log.observations=Array(20).fill(r.log.observations[0]);
    r.log.observations.push({state:'healthy',reason:'sensitive',recoveryAttempted:false});
    const v=normalize(r,Date.parse('2026-11-12T00:10:00Z'));
    assert.equal(v.task.lastResult,0);assert.equal(v.backend.pid,100);assert(v.log.stale);assert(v.log.malformed);assert(v.log.observations.length<=12);assert(!JSON.stringify(v).includes('sensitive'));
    assert.equal(normalize({task:{state:'bogus'},backend:{verified:true},marker:'bogus'},0).task,null);
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
test('UI coalesces polls, aborts hidden polling and discards late results',async()=>{
    let release,calls=0,signal;
    const g=ui(async(_url,options)=>{calls++;signal=options.signal;await new Promise(r=>release=r);return {ok:true,json:async()=>normalize(raw(),Date.now())};});
    const pending=g.monitor.poll();await g.monitor.poll();assert.equal(calls,1);g.document.hidden=true;g.listeners.visibilitychange();assert(signal.aborted);release();await pending;assert.equal(g.timers.size,0);assert(!text(g.host).includes('Backend PID: 100'));g.monitor.dispose();
});
test('UI clears data and stops on authorization failure',async()=>{
    const f=ui(async()=>({ok:false,status:401}));f.document.hidden=true;await f.monitor.poll();assert.equal(f.timers.size,0);f.document.hidden=false;await f.monitor.poll();assert(text(f.host).includes('Administrator session required'));assert.equal(f.timers.size,0);f.monitor.dispose();
});
