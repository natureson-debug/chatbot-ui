'use strict';
// Copied into a disposable application root by provider-startup.test.js only.
const path=require('node:path'),fs=require('node:fs'),http=require('node:http'),Module=require('node:module');
if(!process.send||!fs.existsSync(path.join(__dirname,'.provider-startup-fixture'))||process.env.CHATBOT_DB_PATH!==path.join(__dirname,'data','test.db'))throw Error('Isolated fixture required');
const originalLoad=Module._load;Module._load=function(id,...args){if(id.includes('llama-runtime')||id.includes('runtime/windows'))throw Error('Windows runtime must not initialize');return originalLoad.call(this,id,...args);};
global.fetch=()=>{throw Error('Unexpected outbound fetch');};
require('node:https').request=()=>{throw Error('Unexpected outbound HTTPS');};
http.request=()=>{throw Error('Unexpected outbound HTTP');};
const adapter=require('./core/provider-adapter');adapter.chat=async(provider,input)=>{process.send({type:'inference',provider:provider.id,model:provider.model});if(process.env.FIXTURE_MODE==='unreachable')throw Error('Fixture unreachable');return new Response('data: '+JSON.stringify({choices:[{delta:{content:'fixture answer'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});};
const life=require('./core/application-lifecycle');let lifecycle;const install=life.installApplicationLifecycle;life.installApplicationLifecycle=options=>{lifecycle=install(options);return lifecycle;};
const create=http.createServer;http.createServer=(...args)=>{const server=create(...args),listen=server.listen;server.listen=function(_port,host,cb){return listen.call(this,0,host,()=>{cb();process.send({type:'ready',address:server.address()});});};return server;};
process.on('message',async m=>{if(m==='stop'){const result=await lifecycle.shutdown();process.send({type:'stopped',result});process.disconnect();}});
require('./server');
