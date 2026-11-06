'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {fork}=require('node:child_process');const {DatabaseSync}=require('node:sqlite');
const repo=path.resolve(__dirname,'..');
for(const mode of ['remote','empty','unreachable','disabled','legacy','missing-db'])test('isolated application startup: '+mode,{timeout:15000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-startup-'));let child,ready=false;const events=[];
 t.after(async()=>{if(child&&child.exitCode===null){if(ready)child.send('stop');else child.disconnect();await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();},3000);child.once('close',()=>{clearTimeout(timer);resolve();});});}fs.rmSync(root,{recursive:true,force:true});});
 for(const file of ['server.js','auth.js','db.js'])fs.copyFileSync(path.join(repo,file),path.join(root,file));for(const dir of ['core','public'])fs.cpSync(path.join(repo,dir),path.join(root,dir),{recursive:true});
 fs.copyFileSync(path.join(__dirname,'support/provider-startup-child.cjs'),path.join(root,'child.cjs'));fs.writeFileSync(path.join(root,'.provider-startup-fixture'),'isolated');fs.mkdirSync(path.join(root,'data'));const home=path.join(root,'home');fs.mkdirSync(path.join(home,'config'),{recursive:true});
 const dbFile=path.join(root,'data','test.db');let token;
 if(mode!=='missing-db'){const db=new DatabaseSync(dbFile);require('../core/database-schema').initializeSchema(db);db.prepare("INSERT INTO users VALUES ('u','fixture','unused',1)").run();token=require('../auth').createSession(db,'u');db.close();}
 const connection={id:'remote',name:'Fixture remote',adapter:'ollama',endpoint:'https://fixture.invalid/v1',model:'fixture-model',credentialRef:'env:CHATBOT_FIXTURE_KEY',parameters:[],capabilities:{streaming:true},contextLimit:null,enabled:mode!=='disabled'};
 if(['remote','unreachable','disabled'].includes(mode))fs.writeFileSync(path.join(home,'config','chatbot-connections.json'),JSON.stringify({version:1,revision:0,defaultId:'remote',connections:[connection]}));
 if(mode==='legacy'||mode==='disabled'){fs.mkdirSync(path.join(home,'models'));fs.writeFileSync(path.join(home,'models','fixture.gguf'),'not a real model');fs.writeFileSync(path.join(home,'config','chatbot-ai-config.json'),JSON.stringify({model:'fixture.gguf',contextSize:32768,parallel:1}));}
 let stderr='';child=fork(path.join(root,'child.cjs'),[],{cwd:root,windowsHide:true,env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,NODE_PATH:path.join(repo,'node_modules'),CHATBOT_HOME:home,CHATBOT_DB_PATH:dbFile,CHATBOT_PORT:'4173',FIXTURE_MODE:mode},stdio:['ignore','ignore','pipe','ipc']});child.stderr.on('data',b=>stderr+=b);child.on('message',m=>events.push(m));
 const outcome=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup deadline')),5000);child.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m);}});child.once('exit',code=>{clearTimeout(timer);resolve({exit:code});});});
 if(mode==='missing-db'){assert.notEqual(outcome.exit,0);assert.match(stderr,/DB_STARTUP_FAILED/);assert(!fs.existsSync(dbFile));return;}
 assert.equal(outcome.type,'ready',stderr);ready=true;assert.equal(outcome.address.address,'127.0.0.1');assert(!events.some(e=>e.type==='inference'));
 const url='http://127.0.0.1:'+outcome.address.port;
 const request=(p,body)=>fetch(url+p,{method:body?'POST':'GET',headers:{Cookie:'chatbot_session='+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(3000)});
 assert.equal((await request('/health')).status,200);const runtime=await (await request('/api/ai/runtime')).json();const catalog=await (await request('/api/ai/models')).json();
 if(['empty','disabled'].includes(mode)){assert.equal(runtime.code,'PROVIDER_CONFIGURATION_REQUIRED');assert.equal(catalog.default,null);assert.deepEqual(catalog.models,[]);const r=await request('/api/chat',{messages:[{role:'user',content:'fixture'}]});assert.equal(r.status,503);assert.equal((await r.json()).code,'PROVIDER_CONFIGURATION_REQUIRED');assert(!events.some(e=>e.type==='inference'));}
 else{assert.equal(catalog.models.length,1);const r=await request('/api/chat',{messages:[{role:'user',content:'fixture'}]});const body=await r.text();if(mode==='unreachable')assert(!body.includes('fixture answer'));else assert(body.includes('fixture answer'));assert.equal(events.filter(e=>e.type==='inference').length,1);assert.equal(events.find(e=>e.type==='inference').provider,mode==='legacy'?'legacy-local':'remote');}
 assert(!fs.existsSync(path.join(home,'llama.cpp')));assert(!fs.existsSync(path.join(home,'config','llama-api-key.txt')));
});
