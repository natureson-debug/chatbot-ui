'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {validate,createStore}=require('../core/connections'),models=require('../core/provider-models'),catalog=require('../core/chat-models');
const presets=require('../core/provider-presets.json');
const {createAdapter,usable}=require('../core/provider-adapter');
const connection=()=>({id:'cloud',name:'Cloud account',providerType:'custom',adapter:'openai-compatible',endpoint:'https://example.invalid/v1',model:'alpha',credentialRef:'env:CHATBOT_FIXTURE',parameters:['temperature','max_tokens'],capabilities:{streaming:true,models:true},contextLimit:null,models:[{id:'alpha',name:'Alpha friendly',enabled:true,chat:true,parameters:['max_tokens'],defaults:{max_tokens:64}},{id:'beta',name:'Beta friendly',enabled:true,chat:true,parameters:[],defaults:{}}]});
const config=c=>({version:1,revision:0,defaultId:c.id,connections:[c]});
test('all requested presets select their declared protocol without hardcoded models',()=>{
 assert.equal(presets.length,11);
 for(const p of presets){const c={...connection(),providerType:p.id,adapter:p.adapter,endpoint:p.endpoint||'https://example.invalid/v1'};assert.equal(validate(config(c)).connections[0].adapter,p.adapter);assert.equal(p.model,undefined);if(p.cloud)assert(p.endpoint.startsWith('https://'));}
});
test('native pending adapters reject generation before credentials/network and are hidden from chat catalog',async()=>{
 for(const p of presets.filter(p=>['openai-responses','anthropic-messages','gemini-native'].includes(p.adapter))){
  const c={...connection(),providerType:p.id,adapter:p.adapter};assert.equal(usable(c).streaming,false);assert.deepEqual(catalog.choices(config(c)),[]);assert.throws(()=>catalog.resolve(config(c),{providerId:c.id,model:c.model}));
  const a=createAdapter({secret:async()=>{throw Error('must not read');},fetchImpl:async()=>{throw Error('must not call');}});await assert.rejects(a.chat(c,{messages:[]}),/not implemented/);
 }
});
test('openai provider requires a server credential reference and never stores the value',()=>{
 const c=connection();c.providerType='openai';c.adapter='openai-responses';c.credentialRef='env:CHATBOT_OPENAI_KEY';assert.equal(validate(config(c)).connections[0].credentialRef,'env:CHATBOT_OPENAI_KEY');
 assert.throws(()=>validate(config({...c,credentialRef:null})));
 assert.throws(()=>validate(config({...c,credentialRef:'raw-key'})));
});
test('multi-model choices use friendly labels, enabled chat approvals and immutable per-model parameters',()=>{
 const c=connection();c.models.push({id:'embedding',name:'Embedding',enabled:true,chat:false},{id:'disabled',name:'Disabled',enabled:false,chat:true});const valid=validate(config(c));
 assert.deepEqual(catalog.choices(valid).map(m=>m.name),['Alpha friendly','Beta friendly']);
 const selected=catalog.resolve(valid,{providerId:'cloud',model:'beta'});assert.equal(selected.model,'beta');assert.deepEqual(selected.parameters,[]);valid.connections[0].models[1].id='changed';assert.equal(selected.model,'beta');
 assert.throws(()=>catalog.resolve(valid,{providerId:'cloud',model:'embedding'}));
});
test('invalid model lists, defaults, inline secrets and insecure cloud settings are rejected',()=>{
 for(const change of [c=>c.models.push(c.models[0]),c=>c.models[0].chat=false,c=>c.models[0].enabled=false,c=>c.models[0].defaults={command:'run'},c=>c.models[0].parameters=['unknown'],c=>c.models[0].defaults={max_tokens:0},c=>c.apiKey='do-not-store',c=>c.models[0].id='bad\nmodel']){const c=connection();change(c);assert.throws(()=>validate(config(c)));}
 for(const endpoint of ['http://public.example/v1','https://127.0.0.1/v1','https://169.254.169.254/v1'])assert.throws(()=>validate(config({...connection(),providerType:'openai',adapter:'openai-responses',endpoint})));
});
test('credential reference replacement/removal and multiple accounts persist without storing secret values',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chatbot-cloud-config-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json'),store=createStore(file);
 const initial=config(connection());initial.connections.push({...connection(),id:'second',credentialRef:'env:CHATBOT_SECOND'});await store.save(initial);
 const update=await store.read();update.connections[0].credentialRef='env:CHATBOT_REPLACED';await store.save(update);assert.equal((await store.selected()).credentialRef,'env:CHATBOT_REPLACED');const next=await store.read();next.connections[0].credentialRef=null;await store.save(next);assert.equal((await store.selected()).credentialRef,null);assert.equal((await store.read()).connections[1].credentialRef,'env:CHATBOT_SECOND');
});
test('native discovery uses provider-specific auth and normalizes only model identifiers',async()=>{
 for(const [adapter,header,body] of [['openai-responses','Authorization',{data:[{id:'one'}]}],['anthropic-messages','x-api-key',{data:[{id:'one',display_name:'One'}]}],['gemini-native','x-goog-api-key',{models:[{name:'models/one'}]}]]){
  let options;const a=createAdapter({secret:async()=> 'synthetic',fetchImpl:async(url,o)=>{options=o;assert(url.endsWith('/models'));return new Response(JSON.stringify(body));}});const found=await a.models({...connection(),adapter});assert.equal(found.length,1);assert(options.headers[header].includes('synthetic'));assert(!JSON.stringify(found).includes('synthetic'));assert.equal(options.redirect,'error');
 }
});
test('discovery failure cannot modify configured models or disclose upstream secrets',async()=>{
 const c=connection(),snapshot=JSON.stringify(c);const a=createAdapter({secret:async()=> 'synthetic',fetchImpl:async()=>new Response('secret detail',{status:401})});await assert.rejects(a.testConnection(c),e=>!e.message.includes('secret'));assert.equal(JSON.stringify(c),snapshot);
});
test('admin collect serializes models and native preset without automatic chat approvals',async()=>{
 const source=await fs.readFile('public/admin-connections.js','utf8');const fields={providerId:'cloud',providerName:'Account',providerType:'openai',providerEndpoint:'https://example.invalid/v1',providerAuthMode:'env',providerCredentialRef:'env:CHATBOT_FIXTURE',providerModel:'alpha',providerBackendIdentity:'',providerTimeoutMs:''};const ctx={presets,modelDraft:connection().models,structuredClone,state:{connections:[]},document:{getElementById:id=>({value:fields[id]??'',checked:false})}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf(' function collect()'),source.indexOf(' async function saveProvider(')),ctx);const result=ctx.collect();assert.equal(result.adapter,'openai-responses');assert.equal(result.providerType,'openai');assert.equal(result.models.length,2);assert.equal(result.credentialRef,'env:CHATBOT_FIXTURE');
});
test('admin provider routes deny anonymous/non-admin preset and configuration reads',async()=>{
 const source=await fs.readFile('server.js','utf8');const block=source.slice(source.indexOf('// Named connection administration;'),source.indexOf('// Administrator-only AI configuration',source.indexOf('// Named connection administration;')));
 for(const user of [null,{id:'u',is_admin:0}])for(const url of ['/api/admin/ai/connections','/api/admin/ai/connections/presets']){const ctx={getSessionToken:()=>null,getAuthenticatedUser:()=>user,logAdminAccessDenied(){},logSystemEvent(){},require:()=>{throw Error('Unauthorized dependency access');}};vm.createContext(ctx);vm.runInContext('async function route(req,res){'+block+'}',ctx);let status;await ctx.route({method:'GET',url},{writeHead:s=>status=s,end(){}});assert.equal(status,user?403:401);}
});
test('revocation during admin configuration read prevents returning the configuration',async()=>{
 const source=await fs.readFile('server.js','utf8');const block=source.slice(source.indexOf('// Named connection administration;'),source.indexOf('// Administrator-only AI configuration',source.indexOf('// Named connection administration;')));
 const ctx={db:{},getSessionToken:()=> 'fixture',getAuthenticatedUser:()=>({id:'admin',is_admin:1}),getSessionUser:()=>null,logSystemEvent(){},connections:{read:async()=>config(connection())}};vm.createContext(ctx);vm.runInContext('async function route(req,res){'+block+'}',ctx);let status,body;await ctx.route({method:'GET',url:'/api/admin/ai/connections'},{writeHead:s=>status=s,end:b=>body=b});assert.equal(status,401);assert(!body.includes('CHATBOT_FIXTURE'));
});
test('actual discovery UI preserves existing model configuration on failure',async()=>{
 const source=await fs.readFile('public/admin-connections.js','utf8');const state=config(connection()),before=JSON.stringify(state);const ctx={state,discoverStatus:{textContent:''},modelChoices:{replaceChildren(){throw Error('Must not erase on failure');}},api:async()=>{throw Error('Discovery unavailable');},document:{}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf(' async function discover('),source.indexOf(' function updateType(')),ctx);await ctx.discover('cloud');assert.equal(JSON.stringify(state),before);assert(ctx.discoverStatus.textContent.startsWith('Discovery failed:'));
});
test('per-model capabilities and supported parameters do not silently inherit unsuitable defaults',()=>{
 const c=connection();c.capabilities.vision=true;c.models[1].capabilities={vision:false,tools:false};const selected=models.select(validate(config(c)).connections[0],'beta');assert.equal(selected.capabilities.vision,false);assert.deepEqual(selected.parameters,[]);
});

test('malformed configuration JSON does not reflect submitted secrets',async()=>{
 const source=await fs.readFile('server.js','utf8');const block=source.slice(source.indexOf('// Named connection administration;'),source.indexOf('// Administrator-only AI configuration',source.indexOf('// Named connection administration;')));
 const user={id:'admin',is_admin:1};const ctx={db:{},getSessionToken:()=> 'fixture',getAuthenticatedUser:()=>user,getSessionUser:()=>user,logAdminAccessDenied(){},logSystemEvent(){},connections:{save(){throw Error('Must not save');}},require:()=>({validRestartRequest:()=>true})};vm.createContext(ctx);vm.runInContext('async function route(req,res){'+block+'}',ctx);
 let status,body;await ctx.route({method:'POST',url:'/api/admin/ai/connections',headers:{'x-chatbot-action':'configure-connections'},async *[Symbol.asyncIterator](){yield 'synthetic-private-value malformed';}},{writeHead:s=>status=s,end:b=>body=b});assert.equal(status,400);assert(!body.includes('synthetic-private-value'));assert.equal(JSON.parse(body).error,'Invalid connection configuration JSON.');
});
