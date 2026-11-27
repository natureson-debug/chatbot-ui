'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {handle}=require('../core/chat-capabilities');
const {createDiscovery,cachedCapabilities}=require('../core/model-capabilities');
const c={id:'chatfixture',name:'Fixture',adapter:'ollama',model:'fixture',endpoint:'http://127.0.0.1:9999',credentialRef:null,parameters:[],enabled:true,capabilities:{streaming:true,vision:true,tools:true},contextLimit:null};
test('capability endpoint filters selection, sessions and supported image adapter',async()=>{
 await createDiscovery()(c,c.model,{secret:async()=>null,fetchImpl:async()=>Response.json({capabilities:['completion','vision','tools']})});
 for(const mode of ['ok','anonymous','revoked','disabled','removed','gate','no-image-path']){
  const res={writeHead(n){this.status=n;},end(b){this.body=JSON.parse(b);}};
  await handle({url:'/api/ai/capabilities?providerId=chatfixture&model=fixture'},res,{user:mode==='anonymous'?null:{id:'test'},authenticate:()=>mode==='revoked'?null:{id:'test'},read:async()=>({defaultId:c.id,connections:mode==='removed'?[]:[mode==='disabled'?{...c,enabled:false}:mode==='no-image-path'?{...c,adapter:'openai-compatible'}:c]}),legacy:()=>{throw Error();},permitted:()=>mode!=='gate',imagePath:()=>mode!=='no-image-path'});
  assert.equal(res.status,['ok','no-image-path'].includes(mode)?200:['anonymous','revoked'].includes(mode)?401:404);
  if(res.status===200){assert.equal(res.body.imageInputAvailable,mode==='ok');assert(!JSON.stringify(res.body).includes('endpoint'));}
 }
 assert.equal(cachedCapabilities({...c,endpoint:'http://127.0.0.1:8888'},c.model),null);assert.equal(cachedCapabilities(c,c.model,Date.now()+300001),null);
});
class Element{constructor(){this.children=[];this.dataset={};this.events={};this.files=[];this.textContent='';}appendChild(n){this.children.push(n);}replaceChildren(){this.children=[];}setAttribute(){}before(n){this.previous=n;}addEventListener(n,f){this.events[n]=f;}click(){this.clicked=true;this.events.click?.();}}
function fixture(fetch){
 const footer=new Element(),input=new Element(),remove=new Element(),label=new Element(),head=new Element(),timers=new Map();let id=0;
 const document={head,createElement:()=>new Element(),querySelector:s=>s==='footer'?footer:label,getElementById:s=>s==='attachment'?input:remove};
 const monitor=require('../public/model-selector').createChatCapabilities({document,fetch,setTimer:(f,ms)=>{timers.set(++id,{f,ms});return id;},clearTimer:i=>timers.delete(i)});
 return {monitor,root:footer.previous,input,remove,timers};
}
const data=(model,state='verified',path=true)=>({providerId:'fixture',model,checkedAt:new Date().toISOString(),imageInputAvailable:path,capabilities:Object.fromEntries(['text','vision','documents','tools'].map(k=>[k,{state}]))});
const output=f=>f.root.children.map(x=>x.textContent).join(' ');
test('three states, unavailable provider and adapter image gating',async()=>{
 for(const state of ['verified','unsupported','unknown']){
  const f=fixture(async()=>({ok:true,json:async()=>data('a',state)}));await f.monitor.update({providerId:'fixture',model:'a'});
  assert(output(f).includes('Vision: '+state));assert(output(f).includes('Documents (app): '+state));assert.equal(f.monitor.imageAllowed(),state==='verified');assert.equal(f.input.accept.includes('.png'),state==='verified');assert.equal(f.root.children[4].disabled,state!=='verified');
 }
 const f=fixture(async()=>{throw Error();});await f.monitor.update({providerId:'fixture',model:'a'});assert(output(f).includes('Vision: unknown'));assert(!f.monitor.imageAllowed());
 const noPath=fixture(async()=>({ok:true,json:async()=>data('a','verified',false)}));await noPath.monitor.update({providerId:'fixture',model:'a'});assert(!noPath.monitor.imageAllowed());
});
test('switching ignores late response and reset clears allowance',async()=>{
 let release;const f=fixture(async url=>url.endsWith('model=a')?new Promise(r=>release=()=>r({ok:true,json:async()=>data('a')})):{ok:true,json:async()=>data('b','unsupported')});
 const pending=f.monitor.update({providerId:'fixture',model:'a'});await f.monitor.update({providerId:'fixture',model:'b'});release();await pending;assert(output(f).includes('Vision: unsupported'));await f.monitor.update(null);assert(output(f).includes('Tools: unknown'));
});
test('expiry removes selected image and fails closed',async()=>{
 const f=fixture(async()=>({ok:true,json:async()=>data('a')}));await f.monitor.update({providerId:'fixture',model:'a'});f.input.files=[{name:'image.png'}];[...f.timers.values()].find(x=>x.ms>5000).f();assert(!f.monitor.imageAllowed());assert(f.remove.clicked);
});
test('theme/mobile styles and existing text/tools workflow preserved',()=>{
 const fs=require('node:fs'),css=fs.readFileSync('public/chat-capabilities.css','utf8'),js=fs.readFileSync('public/model-selector.js','utf8');assert(css.includes('--theme-text'));assert(css.includes('flex-wrap:wrap'));assert(css.includes('@media(max-width:600px)'));assert(css.includes(':focus-visible'));assert(!js.includes('skillIds'));assert(!js.includes('allowTools'));assert(!js.includes('localStorage'));assert(js.includes('saveUserSettings()'));
});

test('expiry refresh succeeds, transient failure retains labels but disables images',async()=>{
 let calls=0,fail=false;const f=fixture(async()=>{calls++;if(fail)throw Error();return {ok:true,json:async()=>data('refresh')};});
 const selection={providerId:'fixture',model:'refresh'};await f.monitor.update(selection);assert.equal(calls,1);
 await f.monitor.update(selection,true);assert.equal(calls,2);assert(f.monitor.imageAllowed());
 fail=true;await f.monitor.update(selection,true);assert(output(f).includes('Vision: verified'));assert(output(f).includes('Metadata stale'));assert(!f.monitor.imageAllowed());assert(f.root.children[4].disabled);assert([...f.timers.values()].some(t=>t.ms===30000));
 await f.monitor.update({...selection,model:'different'});assert(output(f).includes('Vision: unknown'));
});
test('server rediscovers empty cache and retains expired profile without image authorization',async()=>{
 const connection={...c,id:'restartfixture'};const config={revision:1,defaultId:connection.id,connections:[connection]};let calls=0;
 const discover=createDiscovery();const original=Date.now;let clock=original();Date.now=()=>clock;
 const run=async(discovery)=>{const res={writeHead(n){this.status=n;},end(b){this.body=JSON.parse(b);}};await handle({url:'/api/ai/capabilities?providerId=restartfixture&model=fixture'},res,{user:{id:'u'},authenticate:()=>({id:'u'}),read:async()=>config,permitted:()=>true,discover:discovery});return res.body;};
 try{
 const success=()=>discover(connection,'fixture',{secret:async()=>null,fetchImpl:async()=>{calls++;return Response.json({capabilities:['completion','vision']});}});
 assert.equal((await run(success)).freshness,'fresh');assert.equal(calls,1);
 clock=Date.parse(cachedCapabilities(connection,'fixture',clock,true).checkedAt)+300001;assert.equal(cachedCapabilities(connection,'fixture'),null);
 const failure=()=>discover(connection,'fixture',{secret:async()=>null,fetchImpl:async()=>{calls++;throw Error('private diagnostic');}});
 const stale=await run(failure);assert.equal(stale.freshness,'stale');assert.equal(stale.capabilities.vision.state,'verified');assert.equal(stale.imageInputAvailable,false);
 await run(failure);assert.equal(calls,2);assert(!JSON.stringify(stale).includes('private diagnostic'));
 }finally{Date.now=original;}
});
