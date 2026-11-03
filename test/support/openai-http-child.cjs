'use strict';
// Test-only bootstrap, copied alongside a disposable application. Never import from production.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),https=require('node:https');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
if(!process.send||process.env.CHATBOT_PORT!=='4173'||!fs.existsSync(path.join(__dirname,'.mp05b3-fixture'))||path.resolve(process.env.CHATBOT_HOME)!==path.resolve(__dirname,'home'))throw Error('Isolated fixture required');
const send=message=>{if(process.connected)process.send(message);};
let mode='complete',pending=null,server,lifecycle;
const nativeEnv=process.env;
process.env=new Proxy(nativeEnv,{get(target,key){if(key==='CHATBOT_SYNTHETIC_OPENAI')send({type:'credential'});return target[key];}});
global.fetch=()=>{throw Error('Unintercepted network forbidden');};
http.request=()=>{throw Error('Unintercepted HTTP forbidden');};
require('node:dns/promises').lookup=async(host,options)=>{
 if(!['openai.fixture.invalid','llama.fixture.invalid','ollama.fixture.invalid'].includes(host)||!options.all)throw Error('DNS outside fixture forbidden');
 send({type:'dns',host});return [{address:'8.8.8.8',family:4}];
};
https.request=(url,options,callback)=>{
 if(!['openai.fixture.invalid','llama.fixture.invalid','ollama.fixture.invalid'].includes(url.hostname)||options.agent!==false||typeof options.lookup!=='function')throw Error('Unsafe fixture request');
 options.lookup(url.hostname,{all:true},(error,addresses)=>{if(error||addresses[0].address!=='8.8.8.8')throw Error('Missing DNS pin');});
 const req=new EventEmitter();let output,ended=false;
 const abort=()=>{if(!ended){ended=true;output?.destroy();send({type:'aborted'});req.emit('error',Error('Fixture cancellation'));}};
 req.destroy=abort;req.end=raw=>{
  const body=raw?JSON.parse(raw):null;
  const authorized=options.headers.Authorization==='Bearer '+nativeEnv.CHATBOT_SYNTHETIC_OPENAI;
  send({type:'request',host:url.hostname,path:url.pathname,body,authorized,mode});
  options.signal.addEventListener('abort',abort,{once:true});
  output=new PassThrough();output.headers={'content-type':'text/event-stream'};
  output.statusCode=mode==='rate'?429:mode==='model-error'?404:200;
  callback(output);
  const write=e=>output.write('data: '+JSON.stringify(e)+'\n\n');
  const finish=()=>{ended=true;options.signal.removeEventListener('abort',abort);output.end();pending=null;};
  if(mode==='rate'||mode==='model-error'){finish();return;}
  if(url.pathname==='/props'){output.write(JSON.stringify({model_alias:'local-model',default_generation_settings:{n_ctx:4096}}));finish();return;}
  if(url.pathname==='/api/ps'){output.write(JSON.stringify({models:[{model:'ollama-model',context_length:4096}]}));finish();return;}
  if(url.hostname==='ollama.fixture.invalid'){output.write(JSON.stringify({message:{content:'Ollama fixture'},done:false})+'\n');output.write(JSON.stringify({done:true,eval_count:2,eval_duration:1000000000,prompt_eval_count:3})+'\n');finish();return;}
  if(url.hostname==='llama.fixture.invalid'){write({choices:[{delta:{content:'Local fixture'},finish_reason:null}]});write({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2}});output.write('data: [DONE]\n\n');finish();return;}
  if(mode==='timeout')return;
  if(mode==='failed'){write({type:'response.failed',response:{status:'failed',error:{message:'sensitive fixture upstream detail'}}});finish();return;}
  write({type:'response.created',response:{id:'resp_fixture',status:'in_progress'}});
  write({type:'response.output_text.delta',output_index:0,content_index:0,delta:'First '});
  const complete=()=>{write({type:'response.output_text.delta',output_index:0,content_index:0,delta:'second'});write({type:'response.output_text.done',output_index:0,content_index:0,text:'First second'});write({type:'response.completed',response:{id:'resp_fixture',status:'completed',usage:{input_tokens:9,output_tokens:2,input_tokens_details:{cached_tokens:1}}}});finish();};
  if(mode==='hold'){pending=complete;return;}complete();
 };return req;
};
const create=http.createServer;
http.createServer=function(...args){server=create.apply(this,args);server.once('listening',()=>{const address=server.address();if(address.address!=='127.0.0.1'||address.port!==4173)throw Error('Invalid binding');send({type:'ready',address});});server.once('error',()=>{send({type:'startup-failed'});process.disconnect();});return server;};
// Reuse the actual graceful shutdown implementation; no PID-based production controls.
const modulePath=require.resolve('./core/application-lifecycle'),original=require(modulePath);
require.cache[modulePath].exports={...original,installApplicationLifecycle(options){lifecycle=original.installApplicationLifecycle(options);return lifecycle;}};
process.on('message',async message=>{
 if(message.type==='mode'){mode=message.mode;send({type:'ack',id:message.id});}
 if(message.type==='release'){pending?.();send({type:'ack',id:message.id});}
 if(message.type==='shutdown'){const result=await lifecycle.shutdown();send({type:'shutdown',result});process.disconnect();}
});
require('./server');
