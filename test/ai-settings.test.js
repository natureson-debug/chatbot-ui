'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {validateAiSettings}=require('../core/ai-settings');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const start=source.indexOf('// Administrator-only AI configuration\n') >= 0 ? source.indexOf('// Administrator-only AI configuration\n') : source.indexOf('// Administrator-only AI configuration\r\n');
// End at the next route, leaving actual config handlers unchanged.
const block=source.slice(start,source.indexOf('if (req.method',source.indexOf('Failed to save AI configuration',source.indexOf('Failed to save AI configuration',start)+1)));
const legacy={model:'model.gguf',parallel:1,contextSize:32768,extension:{keep:true}};
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chatbot-settings-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(legacy));fs.writeFileSync(path.join(dir,'model.gguf'),'fixture');return {dir,file};}
async function route(f,method,payload,user={id:'test',is_admin:1},overrideFs=fs){let status,body;const req={method,url:'/api/admin/ai/config',async *[Symbol.asyncIterator](){yield JSON.stringify(payload);}};
 await vm.runInNewContext('(async()=>{'+block+'})',{req,res:{writeHead(s){status=s},end(s){body=JSON.parse(s)}},fs:overrideFs,AI_CONFIG_FILE:f.file,MODELS_DIR:f.dir,getAuthenticatedUser:()=>user,logAdminAccessDenied(){},logSystemEvent(){},console:{error(){}},require:n=>n==='./core/ai-settings'?{validateAiSettings}:n==='./core/llama-devices'?{listLlamaDevices:async()=>[{id:'CUDA0'},{id:'CUDA1'}]}:require(n)})();return {status,body};}
test('legacy load defaults and unchanged existing controls',async t=>{const f=setup(t),r=await route(f,'GET');assert.equal(r.status,200);assert.deepEqual(r.body,{...legacy,gpuLayers:37,device:'CUDA0',splitMode:'layer',tensorSplit:null,verbosity:4,metrics:false});assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),legacy);});
test('save, reload with fresh handler, old client and extension preservation',async t=>{const f=setup(t);const r=await route(f,'POST',{...legacy,gpuLayers:45,device:'CUDA0',verbosity:4,injected:'ignored'});assert.equal(r.status,200);assert.equal(r.body.config.gpuLayers,45);assert(!('injected' in r.body.config));assert.equal((await route(f,'GET')).body.gpuLayers,45);assert.equal((await route(f,'POST',{...legacy,parallel:2})).body.config.gpuLayers,45);assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).extension,{keep:true});});
test('invalid multi-GPU and existing settings are rejected without partial writes',async t=>{const f=setup(t),before=fs.readFileSync(f.file,'utf8');for(const change of [{gpuLayers:-1},{gpuLayers:1000},{gpuLayers:1.5},{gpuLayers:'45'},{gpuLayers:null},{device:'CUDA9'},{device:'CUDA0,CUDA0'},{device:'CUDA0 --host x'},{device:null},{splitMode:'invalid'},{device:'CUDA0,CUDA1',tensorSplit:'3'},{device:'CUDA0,CUDA1',tensorSplit:'3,0'},{device:'CUDA0',tensorSplit:'1,2'},{verbosity:6},{verbosity:-1},{verbosity:'4'},{verbosity:null},{metrics:'true'},{parallel:0},{contextSize:123},{model:'other.gguf'}]){assert.equal((await route(f,'POST',{...legacy,...change})).status,400,JSON.stringify(change));assert.equal(fs.readFileSync(f.file,'utf8'),before);}});
test('multi-GPU selection and tensor split settings persist and validate',async t=>{const f=setup(t);const saved=await route(f,'POST',{...legacy,device:'CUDA0,CUDA1',splitMode:'layer',tensorSplit:'3, 2'});assert.equal(saved.status,200);assert.equal(saved.body.config.device,'CUDA0,CUDA1');assert.equal(saved.body.config.tensorSplit,'3,2');assert.equal((await route(f,'GET')).body.splitMode,'layer');});
test('available device IDs are canonicalized and decimal proportions are accepted',()=>{const result=validateAiSettings({device:'cuda0,CUDA1',tensorSplit:'1e-1,2.5'},[{id:'CUDA0'},{id:'CUDA1'}]);assert.equal(result.device,'CUDA0,CUDA1');assert.equal(result.tensorSplit,'1e-1,2.5');});
test('bounds accepted',()=>{for(const gpuLayers of [0,37,45,999])for(const verbosity of [0,4,5])assert.equal(validateAiSettings({gpuLayers,verbosity}).gpuLayers,gpuLayers);});
test('anonymous and non-admin cannot read or save',async t=>{const f=setup(t);for(const method of ['GET','POST']){assert.equal((await route(f,method,legacy,null)).status,401);assert.equal((await route(f,method,legacy,{is_admin:0})).status,403);}assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),legacy);});
test('failed replacement retains old config and removes temporary file',async t=>{const f=setup(t);const r=await route(f,'POST',{...legacy,gpuLayers:45},undefined,{...fs,renameSync(){throw Error('fixture failure')}});assert.equal(r.status,400);assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),legacy);assert(!fs.readdirSync(f.dir).some(n=>n.endsWith('.tmp')));});
test('actual frontend load and save use optional fields without a restart request',async()=>{
 const ui=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
 const nodes=Object.fromEntries(['aiModel','aiParallel','aiContextSize','aiGpuLayers','aiDevice','aiVerbosity','aiConfigStatus','aiSplitMode','aiTensorSplit'].map(k=>[k,{value:''}]));
 nodes.aiMetrics={checked:false};let selectedDevices=['CUDA0'];
 let click,payload;const requests=[];
 const ctx={...nodes,console,updateContextPerSlot(){},setSelectedGpuDevices(value){nodes.aiDevice.value=value;},selectedGpuDevices:()=>selectedDevices,loadAiServerStatus:async()=>{},saveAiConfig:{addEventListener(_,fn){click=fn}},fetch:async(url,options)=>{requests.push(url);if(options?.method==='POST'){payload=JSON.parse(options.body);return{ok:true,json:async()=>({config:payload})};}return{ok:true,json:async()=>({...legacy,gpuLayers:45,device:'CUDA0',splitMode:'layer',tensorSplit:null,verbosity:5,metrics:true})};}};
 vm.runInNewContext(ui.slice(ui.indexOf('async function loadAiConfig()'),ui.indexOf('async function initializeAiConfig()'))+';globalThis.load=loadAiConfig;',ctx);
 await ctx.load();assert.equal(nodes.aiGpuLayers.value,45);assert.equal(nodes.aiVerbosity.value,5);assert.equal(nodes.aiMetrics.checked,true);
 vm.runInNewContext(ui.slice(ui.indexOf('saveAiConfig.addEventListener("click"')),ctx);
 await click();assert.equal(payload.gpuLayers,45);assert.equal(payload.device,'CUDA0');assert.equal(payload.splitMode,'layer');assert.equal(payload.tensorSplit,null);assert.equal(payload.verbosity,5);assert.equal(payload.contextSize,32768);assert.equal(payload.metrics,true);assert(requests.every(url=>url==='/api/admin/ai/config'));assert(nodes.aiConfigStatus.textContent.includes('Restart required'));
});

async function saveResponseFixture(reply) {
 const ui=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
 const values={aiModel:'model.gguf',aiParallel:'1',aiContextSize:'32768',aiGpuLayers:'45',aiDevice:'CUDA0',aiVerbosity:'4',aiSplitMode:'layer',aiTensorSplit:''};
 const nodes=Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value}]));
 nodes.aiMetrics={checked:false};
 let click,calls=0,refreshes=0;
 const ctx={...nodes,aiConfigStatus:{},console:{error(){},warn(){}},selectedGpuDevices:()=>['CUDA0'],saveAiConfig:{addEventListener(_,fn){click=fn}},
  loadAiServerStatus:async()=>{refreshes++;},fetch:async(_url,options)=>{calls++;const submitted=JSON.parse(options.body);return {ok:true,json:async()=>({config:reply(submitted)})};}};
 vm.runInNewContext(ui.slice(ui.indexOf('saveAiConfig.addEventListener("click"')),ctx);
 await click();assert.equal(calls,1);assert.equal(ctx.saveAiConfig.disabled,false);
 return {message:ctx.aiConfigStatus.textContent,refreshes};
}
test('legacy three-field save response reports persistence mismatch, not success',async()=>{
 const r=await saveResponseFixture(({model,parallel,contextSize})=>({model,parallel,contextSize}));
 assert.match(r.message,/Persistence mismatch/);assert(!r.message.includes('Configuration saved.'));assert.equal(r.refreshes,0);
});
test('matching six-field response confirms save with numeric JSON values',async()=>{
 const r=await saveResponseFixture(s=>({...s}));assert.match(r.message,/Configuration saved\./);assert.equal(r.refreshes,1);
});
test('each missing or different property and numeric display strings reject confirmation',async()=>{
 for(const key of ['model','parallel','contextSize','gpuLayers','device','splitMode','tensorSplit','verbosity','metrics']) {
  const missing=await saveResponseFixture(s=>{delete s[key];return s;});assert.match(missing.message,/Persistence mismatch/,key);
  const changed=await saveResponseFixture(s=>({...s,[key]:typeof s[key]==='number'?s[key]+1:s[key]+'x'}));assert.match(changed.message,/Persistence mismatch/,key);
 }
 for(const key of ['parallel','contextSize','gpuLayers','verbosity']) {
  const r=await saveResponseFixture(s=>({...s,[key]:String(s[key])}));assert.match(r.message,/Persistence mismatch/,key);
 }
 for(const value of [undefined,null,[],{}])assert.match((await saveResponseFixture(()=>value)).message,/Persistence mismatch/);
});
