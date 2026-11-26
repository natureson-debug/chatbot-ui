'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classify}=require('../core/model-capabilities');
const {createAdapter}=require('../core/provider-adapter');
const connection=()=>({id:'fixture',adapter:'ollama',endpoint:'http://127.0.0.1:9999/v1',model:'fixture',credentialRef:null,capabilities:{streaming:true,models:true},parameters:[],enabled:true});
test('Ollama vision/tools metadata uses authenticated show only and preserves configuration',async()=>{
 const c=connection(),before=JSON.stringify(c);let calls=0;
 const adapter=createAdapter({secret:async()=> 'synthetic-key',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'http://127.0.0.1:9999/api/show');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-key');assert.deepEqual(JSON.parse(options.body),{model:'fixture',verbose:false});
  return Response.json({capabilities:['completion','vision','tools'],secret:'never-expose'});
 }});
 const r=await adapter.capabilities(c,'fixture');assert.equal(r.capabilities.vision.state,'verified');assert.equal(r.capabilities.tools.state,'verified');assert.equal(r.capabilities.text.state,'verified');assert.equal(r.capabilities.documents.scope,'application');assert(r.capabilities.vision.verifiedAt);assert(!JSON.stringify(r).includes('secret'));assert.equal(JSON.stringify(c),before);
 await adapter.capabilities(c,'fixture');assert.equal(calls,1);assert.equal(adapter.usable(c).tools,false);
});
test('missing metadata unknown, explicit complete Ollama declaration unsupported',()=>{
 const c=connection();assert.equal(classify(c,c.model,{},'now').capabilities.vision.state,'unknown');
 assert.equal(classify(c,c.model,{capabilities:['completion']},'now').capabilities.tools.state,'unsupported');
});
test('llama missing metadata or identity mismatch never inferred from name',()=>{
 const c={...connection(),adapter:'llama.cpp',model:'Vision-VL',backendModelIdentity:'exact.gguf'};
 for(const props of [{model_path:'exact.gguf'},{model_path:'wrong.gguf',modalities:{vision:true}},{model_path:'exact.gguf',modalities:{vision:'true'}}])assert.equal(classify(c,c.model,props,'now').capabilities.vision.state,'unknown');
 assert.equal(classify(c,c.model,{model_path:'exact.gguf',modalities:{vision:true}},'now').capabilities.vision.state,'verified');
});
test('unreachable and malformed providers fail safely without secret diagnostics',async()=>{
 for(const fetchImpl of [async()=>{throw Error('synthetic-key /private/path');},async()=>new Response('not-json'),async()=>Response.json({}, {status:401})]){
  const a=createAdapter({fetchImpl,secret:async()=>null});await assert.rejects(a.capabilities(connection(),'fixture'),/^Error: Model capability metadata unavailable$/);
 }
});
test('other providers unknown without credential access or network, unconfigured model refused',async()=>{
 const a=createAdapter({fetchImpl:()=>{throw Error('Unexpected network');},secret:()=>{throw Error('Unexpected secret');}});
 const r=await a.capabilities({...connection(),adapter:'openai-compatible'},'fixture');assert.equal(r.capabilities.text.state,'unknown');assert.equal(r.capabilities.tools.verifiedAt,null);
 await assert.rejects(a.capabilities(connection(),'other'),/Configured model required/);
});
test('llama props endpoint is native and metadata body is bounded',async()=>{
 const c={...connection(),adapter:'llama.cpp'};
 const a=createAdapter({secret:async()=>null,fetchImpl:async(url,o)=>{assert.equal(url,'http://127.0.0.1:9999/props');assert.equal(o.method,'GET');return new Response('x'.repeat(1048577));}});
 await assert.rejects(a.capabilities(c,'fixture'),/metadata unavailable/);
});
test('mock Admin panel displays all capabilities, resets and uses shared notifications',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const source=fs.readFileSync('public/admin-connections.js','utf8');
 class Element{constructor(){this.children=[];this.events={};this.textContent='';}append(...x){this.children.push(...x);}appendChild(x){this.children.push(x);}replaceChildren(){this.children=[];this.textContent='';}setAttribute(){}addEventListener(n,f){this.events[n]=f;}}
 const notifications=[];let fail=false;const context={};vm.createContext(context);vm.runInContext(source.slice(source.indexOf(' function createCapabilityPanel('),source.indexOf(' function setStatus(')),context);
 const panel=context.createCapabilityPanel({document:{createElement:()=>new Element()},api:async()=>{if(fail)throw Error();return classify(connection(),'fixture',{capabilities:['completion','tools']},new Date().toISOString());},notify:n=>notifications.push(n)});
 panel.reset(connection());const button=panel.root.children[2],details=panel.root.children[3];await button.events.click();
 const output=details.children.map(x=>x.textContent).join(' ');assert(output.includes('Tool calling: verified'));assert(output.includes('Vision: unsupported'));assert(output.includes('Document processing (application'));assert.equal(notifications[0].severity,'success');
 fail=true;await button.events.click();assert(details.textContent.includes('unavailable'));assert.equal(notifications[1].severity,'error');panel.reset(null);assert.equal(button.disabled,true);
});
test('actual admin route denies anonymous/nonadmin and rechecks session after metadata',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync('server.js','utf8');
 const start=source.indexOf('if (req.url === "/api/admin/ai/connections/presets"');
 const end=source.indexOf('\n}',start)+2;
 for(const mode of ['anonymous','user','admin','revoked']){
  let calls=0;const admin=mode==='anonymous'?null:{id:'a',is_admin:mode==='user'?0:1};
  const context={require:name=>{assert.equal(name,'./core/restart-request');return {validRestartRequest:()=>true};},AbortSignal,db:{},getSessionToken:()=> 'synthetic',getAuthenticatedUser:()=>admin,getSessionUser:()=>mode==='revoked'&&calls?null:admin,logAdminAccessDenied:()=>{},logSystemEvent:()=>{},
   connections:{read:async()=>({revision:1,connections:[connection()]})},providers:{capabilities:async()=>{calls++;return {capabilities:{text:{state:'unknown'}}};}},
   req:{url:'/api/admin/ai/connections/fixture/capabilities',method:'POST',headers:{'x-chatbot-action':'configure-connections'},async *[Symbol.asyncIterator](){yield '{"model":"fixture"}';}},
   res:{writeHead(code){this.code=code;},end(body){this.body=JSON.parse(body);}}
  };
  await vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',context);
  assert.equal(context.res.code,mode==='admin'?200:mode==='user'?403:401);assert.equal(calls,['admin','revoked'].includes(mode)?1:0);
 }
});
