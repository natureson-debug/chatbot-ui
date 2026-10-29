'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {build}=require('../build.cjs'),{open}=require('../broker-client.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatbot-owned-test-'));
console.log('TEST_ROOT='+root);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function setup(name,mode='normal'){
 const p=await port(),dir=path.join(root,name),report=path.join(dir,'signal.txt'),fixture=path.join(__dirname,'fixture.cjs');
 const exe=build({operatorSid:require('../profile.json').sid,executable:process.execPath,cwd:__dirname,args:[fixture,String(p),mode,report],fixture:true,port:p,host:'127.0.0.1',pinFiles:[fixture],shutdownMs:mode==='slow-stop'?30000:400},dir);
 return {p,dir,exe,report};
}
async function ready(b){const end=Date.now()+4000;while(Date.now()<end){const s=await b.request('STATUS');if(s.listener)return s;if(s.status==='exited')throw Error('early exit');await pause(20);}throw Error('fixture readiness');}
async function cleanup(b){try{await b.request('STOP');}catch{}b.disconnect();await b.exit;}
test('retained identity, listener, duplicate start, private graceful signal, redaction',async()=>{
 const x=await setup('normal'),b=await open(x.exe,x.dir);
 try{
  const s=await b.request('START');assert.equal(s.status,'owned');const r=await ready(b);
  assert.equal(r.pid,s.pid);assert.equal(r.created,s.created);assert.equal((await b.request('START')).status,'duplicate-launch-rejected');
  assert(!JSON.stringify(r).includes('FAKE_API_KEY'));await assert.rejects(b.request('TERMINATE 1234'));
  assert.equal((await b.request('STOP')).status,'graceful-complete');assert.equal(fs.readFileSync(x.report,'utf8'),'SIGINT');
  assert.equal(fs.existsSync(path.join(x.dir,'child.lease')),false);await b.request('QUIT');
 }finally{b.disconnect();await b.exit;}
});
test('two broker processes cannot launch same installation service',async()=>{
 const x=await setup('concurrent'),a=await open(x.exe,x.dir),b=await open(x.exe,x.dir);
 try{await a.request('START');await ready(a);await assert.rejects(b.request('START'));assert.equal((await a.request('STATUS')).status,'owned');}
 finally{await cleanup(a);b.disconnect();await b.exit;}
});
test('foreign occupied port blocks before launch without touching listener',async()=>{
 const x=await setup('occupied'),s=net.createServer();await new Promise(r=>s.listen(x.p,'127.0.0.1',r));
 const b=await open(x.exe,x.dir);try{await assert.rejects(b.request('START'));assert(s.listening);}finally{b.disconnect();await b.exit;await new Promise(r=>s.close(r));}
});
test('incomplete graceful shutdown retains ownership; no force API',async()=>{
 const x=await setup('ignore','ignore'),b=await open(x.exe,x.dir);await b.request('START');await ready(b);
 try{assert.equal((await b.request('STOP')).status,'incomplete');assert(fs.existsSync(path.join(x.dir,'child.lease')));await assert.rejects(b.request('FORCE'));assert.equal((await b.request('STATUS')).status,'owned');}
 finally{b.disconnect();await b.exit;} // fixture self-expires, no termination by test
});
test('supervisor disconnect cooperatively stops only its child',async()=>{
 const x=await setup('disconnect'),b=await open(x.exe,x.dir);await b.request('START');await ready(b);b.disconnect();await b.exit;
 assert.equal(fs.readFileSync(x.report,'utf8'),'SIGINT');assert(!fs.existsSync(path.join(x.dir,'child.lease')));
});
test('crashed child verified exited with streams and listener released',async()=>{
 const x=await setup('crash','crash'),b=await open(x.exe,x.dir);await b.request('START');
 try{let r;do{await pause(30);r=await b.request('STATUS');}while(r.status!=='exited');assert(r.streamsClosed&&r.listenerReleased);await b.request('QUIT');}
 finally{b.disconnect();await b.exit;}
});
test('stale durable lease blocks launch, never adopted or reclaimed',async()=>{
 const x=await setup('stale');fs.writeFileSync(path.join(x.dir,'child.lease'),'stale evidence');const b=await open(x.exe,x.dir);
 try{await assert.rejects(b.request('START'));assert.equal(fs.readFileSync(path.join(x.dir,'child.lease'),'utf8'),'stale evidence');}
 finally{b.disconnect();await b.exit;}
});
test('no PID-reopen or arbitrary termination API exists in native adapter',()=>{
 const source=fs.readFileSync(path.join(__dirname,'..','src','broker.cpp'),'utf8');
 assert(!/\bOpenProcess\s*\(|\bTerminateProcess\s*\(|\bTerminateJobObject\s*\(/.test(source));
 assert(source.includes('GetProcessTimes(process.get()'));
});

test('helper crash leaves orphan lease; replacement blocked until fixture exits',async()=>{
 const x=await setup('broker-crash'),report=path.join(x.dir,'identity.json');
 const {spawn}=require('node:child_process');
 const child=spawn(process.execPath,[path.join(__dirname,'crash-driver.cjs'),x.exe,'broker-crash',report],{windowsHide:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',c=>c===0?resolve():reject(Error('crash driver failed')))});
 assert(fs.existsSync(report));assert(fs.existsSync(path.join(x.dir,'child.lease')));
 const b=await open(x.exe,x.dir);try{await assert.rejects(b.request('START'));}finally{b.disconnect();await b.exit;}
 // No PID-based cleanup. The harmless fixture has an independent 12-second lifetime.
 await pause(12500);
 const s=net.createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(x.p,'127.0.0.1',resolve)});await new Promise(r=>s.close(r));
 assert(fs.existsSync(path.join(x.dir,'child.lease')));
});
test('actual supervisor crash closes private pipe and cooperatively cleans fixture',async()=>{
 const x=await setup('supervisor-crash'),report=path.join(x.dir,'identity.json'),{spawn}=require('node:child_process');
 const child=spawn(process.execPath,[path.join(__dirname,'crash-driver.cjs'),x.exe,'supervisor-crash',report],{windowsHide:true,stdio:'ignore'});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});assert.equal(code,86);
 const end=Date.now()+3000;while(fs.existsSync(path.join(x.dir,'child.lease'))&&Date.now()<end)await pause(20);
 assert.equal(fs.readFileSync(x.report,'utf8'),'SIGINT');assert(!fs.existsSync(path.join(x.dir,'child.lease')));
});

test('21-second graceful drain fits 30-second native and 35-second client windows',async()=>{
 const x=await setup('slow-stop','slow-stop'),b=await open(x.exe,x.dir);
 try{await b.request('START');await ready(b);const started=Date.now();const result=await b.request('STOP');
 assert.equal(result.status,'graceful-complete');assert(Date.now()-started>=21000);assert(result.streamsClosed&&result.listenerReleased);await b.request('QUIT');
 }finally{b.disconnect();await b.exit;}
});
