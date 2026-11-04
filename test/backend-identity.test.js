'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {validate,createStore}=require('../core/connections');
const {createAdapter}=require('../core/provider-adapter');
const {observe}=require('../core/context-telemetry');
const identity='C:\\fixture\\model.gguf';
const connection={id:'local',name:'Friendly provider',adapter:'llama.cpp',endpoint:'https://fixture.invalid/v1',model:'friendly:alias',credentialRef:null,parameters:[],capabilities:{streaming:true},contextLimit:null};
const config=c=>({version:1,revision:0,defaultId:'local',connections:[c]});
test('optional mapping validates and persists through existing revision store without changing request identity',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'chatbot-identity-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const store=createStore(path.join(directory,'connections.json'));
 await store.save(config({...connection,backendModelIdentity:identity}));const selected=await store.selected();assert.equal(selected.model,'friendly:alias');assert.equal(selected.backendModelIdentity,identity);
 const saved=await store.read();saved.connections[0].backendModelIdentity=null;await store.save(saved);assert.equal((await store.selected()).backendModelIdentity,undefined);
});
test('existing configs unchanged; invalid and non-llama mappings rejected',()=>{
 assert.equal(validate(config(connection)).connections[0].backendModelIdentity,undefined);
 for(const backendModelIdentity of ['', ' ',1,{},'bad\nidentity','x'.repeat(4097)])assert.throws(()=>validate(config({...connection,backendModelIdentity})));
 assert.throws(()=>validate(config({...connection,adapter:'ollama',backendModelIdentity:identity})));
 assert.equal(validate(config({...connection,backendModelIdentity:identity})).connections[0].backendModelIdentity,identity);
});
test('mapped identity reaches metrics while inference still sends friendly alias',async()=>{
 let request;
 const a=createAdapter({secret:async()=>null,fetchImpl:async(url,o)=>{
  if(o.method==='POST'){request=JSON.parse(o.body);return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');}
  return new Response(JSON.stringify({model_alias:identity,model_path:identity,default_generation_settings:{n_ctx:32768},total_slots:1}));
 }});
 const r=await a.chat({...connection,backendModelIdentity:identity},{messages:[{role:'user',content:'fixture'}]});const output=await r.text();assert.equal(request.model,connection.model);assert.equal(request.backendModelIdentity,undefined);assert(output.includes('"contextCapacityTokens":32768'));
});
test('missing mapping, replacement, explicit mismatch and invalid capacity fail closed',async()=>{
 for(const [mapping,backend,n,expected] of [[undefined,identity,32768,null],[identity,'replacement',32768,null],['wrong',identity,32768,null],[identity,identity,0,null],[identity,identity,32768,32768]]){
  const result=await observe({...connection,backendModelIdentity:mapping},{secret:async()=>null,fetchImpl:async()=>new Response(JSON.stringify({model_alias:backend,model_path:backend,default_generation_settings:{n_ctx:n},total_slots:4}))});assert.equal(result.contextCapacityTokens,expected);
 }
});
test('admin form collects explicit identity without altering friendly model',async()=>{
 const vm=require('node:vm'),source=await fs.readFile('public/admin-connections.js','utf8');const fields={providerId:'local',providerName:'Friendly',providerType:'llama.cpp-openai',providerEndpoint:connection.endpoint,providerAuthMode:'none',providerModel:connection.model,providerBackendIdentity:identity,providerTimeoutMs:''};const context={document:{getElementById:id=>({value:fields[id]??'',checked:false})}};vm.createContext(context);vm.runInContext(source.slice(source.indexOf(' function collect()'),source.indexOf(' async function saveProvider(')),context);
 assert.equal(context.collect().backendModelIdentity,identity);assert.equal(context.collect().model,connection.model);fields.providerBackendIdentity='';assert.equal(context.collect().backendModelIdentity,null);
});
test('switching away from llama.cpp clears incompatible backend identity instead of trapping save',async()=>{
 const vm=require('node:vm'),source=await fs.readFile('public/admin-connections.js','utf8'),presets=require('../core/provider-presets.json');
 const fields={providerApiKey:{},providerTestStatus:{},providerProtectedKey:{},providerStreamingLabel:{},providerType:{value:'openai'},providerEndpoint:{value:''},providerAuthMode:{value:'none'},providerProtocolStatus:{textContent:''},providerBackendIdentity:{value:identity,disabled:false,closest(){return {querySelector(){return {hidden:false}}};}},providerPrivateNetwork:{disabled:false,checked:false},providerAllowInsecureHttp:{disabled:false,checked:false},providerCredentialRef:{disabled:false}};
 const context={presets,document:{getElementById:id=>fields[id]}};vm.createContext(context);vm.runInContext(source.slice(source.indexOf(' function updateType('),source.indexOf(' function renderModels(')),context);
 context.updateType(true);
 assert.equal(fields.providerBackendIdentity.value,'');
 assert.equal(fields.providerBackendIdentity.disabled,true);
});
