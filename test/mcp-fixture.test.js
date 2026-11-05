'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {spawn}=require('node:child_process');
const fixture=path.join(__dirname,'support/mcp-readonly-fixture.cjs');
test('real stdio initialization/list/call, unique nonces, invalid arguments and clean EOF with I/O guards',{timeout:10000},async t=>{
 const child=spawn(process.execPath,['--require',path.join(__dirname,'support/mcp-fixture-io-guard.cjs'),fixture],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stderr='',buffer='';const replies=new Map();let id=0;
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 child.stderr.on('data',b=>stderr+=b);
 child.stdout.on('data',b=>{buffer+=b;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);let m;try{m=JSON.parse(line);}catch{assert.fail('Non-protocol stdout');}assert.equal(m.jsonrpc,'2.0');replies.set(m.id,m);}});
 const send=m=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
 const call=async(method,params)=>{const requestId=++id;send({id:requestId,method,params});const deadline=Date.now()+3000;while(!replies.has(requestId)){if(Date.now()>deadline)throw Error('Fixture response timeout: '+stderr);await new Promise(r=>setTimeout(r,5));}return replies.get(requestId);};
 t.after(async()=>{child.stdin.end();if(child.exitCode===null){await Promise.race([closed,new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null)child.kill();}await closed;});
 const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-test',version:'1'}});assert.equal(init.result.serverInfo.name,'chatbot-mcp-test');send({method:'notifications/initialized'});
 const list=await call('tools/list',{});assert.deepEqual(list.result.tools.map(t=>t.name),['fixture_status']);assert.equal(list.result.tools[0].annotations.readOnlyHint,true);
 const first=await call('tools/call',{name:'fixture_status',arguments:{}}),second=await call('tools/call',{name:'fixture_status',arguments:{}});
 const a=JSON.parse(first.result.content[0].text),b=JSON.parse(second.result.content[0].text);assert.equal(a.identifier,'chatbot-mcp-test');assert.match(a.nonce,/^[0-9a-f]{32}$/);assert.notEqual(a.nonce,b.nonce);
 assert((await call('tools/call',{name:'fixture_status',arguments:{unexpected:true}})).error);
 assert((await call('tools/call',{name:'unknown',arguments:{}})).error);
 child.stdin.end();const exit=await closed;assert.deepEqual(exit,{code:0,signal:null});assert.equal(stderr,'');assert.equal(buffer,'');
});
test('existing application discovery client lists fixture without configuring production',{timeout:10000},async()=>{
 const {discover}=require('../core/mcp-client');const tools=await discover({id:'local-fixture',transport:'stdio',command:process.execPath,args:[fixture],tools:[]});
 assert.equal(tools.length,1);assert.equal(tools[0].name,'fixture_status');assert.deepEqual(tools[0].inputSchema,{type:'object',properties:{},additionalProperties:false});
});
test('fixture source has only SDK/crypto dependencies and no application or environment access',()=>{
 const source=fs.readFileSync(fixture,'utf8');const imports=[...source.matchAll(/require\('([^']+)'\)/g)].map(m=>m[1]);assert.deepEqual(imports,['@modelcontextprotocol/sdk/server/index.js','@modelcontextprotocol/sdk/server/stdio.js','@modelcontextprotocol/sdk/types.js','node:crypto']);assert.doesNotMatch(source,/process\.env|console\.log|fetch\(|readFile|writeFile/);
});
