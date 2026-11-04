'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {isIP}=require('node:net');
const {AI_CONFIG_FILE}=require('./paths');
const presets=require('./provider-presets.json');
const modelConfig=require('./provider-models');
const file=path.join(path.dirname(AI_CONFIG_FILE),'chatbot-connections.json');
const fail=message=>{throw Error('Invalid connection configuration'+(message?': '+message:''));};
function canonicalAdapter(adapter){
 if(adapter==='llama.cpp'||adapter==='llama.cpp-openai')return 'llama.cpp';
 if(adapter==='openai-compatible'||adapter==='generic-openai')return 'openai-compatible';
 if(adapter==='ollama')return 'ollama';
 if(['openai-responses','deepseek-chat','anthropic-messages','gemini-native'].includes(adapter))return adapter;
 return null;
}
function isLoopback(host){
 const h=host.replace(/^\[|\]$/g,'').toLowerCase();
 return h==='localhost'||h==='::1'||h.startsWith('127.');
}
function isPrivateAddress(host){
 const h=host.replace(/^\[|\]$/g,'').toLowerCase();
 if(isLoopback(host))return false;
 if(h==='0.0.0.0'||h==='::')return true;
 if(isIP(h)===4){
  const p=h.split('.').map(Number);
  if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return true;
  return p[0]===10||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===169&&p[1]===254||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===0||p[0]===127;
 }
 if(isIP(h)===6){
  return h.startsWith('fc')||h.startsWith('fd')||h.startsWith('fe8')||h.startsWith('fe9')||h.startsWith('fea')||h.startsWith('feb')||h.startsWith('ff')||h==='::';
 }
 return false;
}
function validate(value){
 if(!value||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.connections)||value.connections.length>20)fail('top-level version, revision, and connections are required');
 const ids=new Set();
 const connections=value.connections.map((c,index)=>{
  const record=`connection ${index}`;
  if(!c||!/^[a-z][a-z0-9-]{0,47}$/.test(c.id)||ids.has(c.id)||typeof c.name!=='string'||!c.name.trim()||c.name.length>80)throw Error(`Invalid connection configuration: ${record} has invalid id, name, or adapter`);ids.add(c.id);
  const adapter=canonicalAdapter(c.providerType==='deepseek'&&c.adapter==='openai-compatible'?'deepseek-chat':c.adapter);if(!adapter)fail(`${record} has an unsupported adapter`);
  const preset=c.providerType===undefined?null:presets.find(p=>p.id===c.providerType);
  if(c.providerType!==undefined&&(!preset||preset.adapter!==adapter))fail('Provider type and adapter do not match');
  if(['apiKey','api_key','password','secret','headers'].some(k=>Object.hasOwn(c,k)))fail('Use a server credential reference, not inline credentials');
  let url;try{url=new URL(c.endpoint);}catch{fail('endpoint must be a valid URL');}
  if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol))fail('endpoint must be HTTPS or HTTP without credentials, query, or fragment');
  const loopback=isLoopback(url.hostname),priv=isPrivateAddress(url.hostname);
  if(preset?.id==='custom'&&url.protocol!=='https:'&&!loopback&&!(priv&&c.privateNetwork===true&&c.allowInsecureHttp===true))fail('Public custom endpoints require HTTPS');
  if((preset?.cloud||['openai-responses','deepseek-chat','anthropic-messages','gemini-native'].includes(adapter))&&(url.protocol!=='https:'||loopback||priv||c.privateNetwork===true||c.allowInsecureHttp===true))fail('Cloud providers require public HTTPS endpoints');
  if(url.protocol==='http:'&&!loopback&&c.allowInsecureHttp!==true)fail('plain HTTP requires loopback or allowInsecureHttp');
  if(priv&&c.privateNetwork!==true)fail('private network endpoint requires privateNetwork');
  if(typeof c.model!=='string'||!c.model.trim()||c.model.length>512||/[\x00-\x1f]/.test(c.model))fail('model is required');
  if(c.backendModelIdentity!==undefined&&c.backendModelIdentity!==null&&
     (adapter!=='llama.cpp'||typeof c.backendModelIdentity!=='string'||!c.backendModelIdentity.trim()||
      c.backendModelIdentity.length>4096||/[\x00-\x1f\x7f]/.test(c.backendModelIdentity)))fail('backendModelIdentity must be an exact nonempty llama.cpp model ID or path');
  if(c.credentialRef!==null&&!(typeof c.credentialRef==='string'&&/^env:CHATBOT_[A-Z0-9_]{1,80}$/.test(c.credentialRef))&&c.credentialRef!=='local-api-key'&&!(adapter==='deepseek-chat'&&c.credentialRef==='protected:'+c.id))fail('credentialRef must be env:CHATBOT_* or local-api-key');
  if(c.credentialRef==='local-api-key'&&!(adapter==='llama.cpp'&&url.origin==='http://127.0.0.1:8080'))fail('local-api-key requires llama.cpp on http://127.0.0.1:8080');
  if(['openai-responses','deepseek-chat'].includes(adapter)&&c.credentialRef!=='protected:'+c.id&&!(typeof c.credentialRef==='string'&&/^env:CHATBOT_[A-Z0-9_]{1,80}$/.test(c.credentialRef)))fail('OpenAI provider requires an env:CHATBOT_* credential reference');
  if(adapter==='ollama'&&c.credentialRef===null&&!loopback&&!(priv&&c.privateNetwork===true))fail('no-auth Ollama requires loopback or approved private network');
  if(!Array.isArray(c.parameters)||c.parameters.some(p=>!['temperature','max_tokens'].includes(p)))fail('parameters may only contain temperature and max_tokens');
  if(!c.capabilities||Object.values(c.capabilities).some(v=>typeof v!=='boolean')||Object.keys(c.capabilities).some(k=>!['streaming','thinking','vision','tools','models'].includes(k))||c.capabilities.streaming!==true)fail('capabilities must include streaming=true and only supported booleans');
  if(c.contextLimit!==null&&(!Number.isSafeInteger(c.contextLimit)||c.contextLimit<1))fail('contextLimit must be null or a positive integer');
  if(c.timeoutMs!==undefined&&c.timeoutMs!==null&&(!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<1000||c.timeoutMs>600000))fail('timeoutMs must be between 1000 and 600000');
  if(c.enabled!==undefined&&typeof c.enabled!=='boolean')fail('enabled must be a boolean');
  if(c.streaming!==undefined&&(adapter!=='deepseek-chat'||typeof c.streaming!=='boolean'))fail('Invalid streaming setting');
  const models=modelConfig.validateModels(c.models,c);
  return {...(adapter==='deepseek-chat'?{streaming:c.streaming!==false}:{}),...(preset?{providerType:preset.id}:{}),...(models?{models}:{}),id:c.id,name:c.name,adapter,endpoint:url.href.replace(/\/$/,''),model:c.model,...(c.backendModelIdentity==null?{}:{backendModelIdentity:c.backendModelIdentity}),credentialRef:c.credentialRef,parameters:[...new Set(c.parameters)],capabilities:{...c.capabilities},contextLimit:c.contextLimit,privateNetwork:c.privateNetwork===true,allowInsecureHttp:c.allowInsecureHttp===true,timeoutMs:c.timeoutMs??null,enabled:c.enabled!==false};
 });
 if(value.defaultId!=='legacy-local'&&!ids.has(value.defaultId)||ids.has('legacy-local'))fail('defaultId must reference an existing connection or legacy-local');
 return {version:1,revision:value.revision,defaultId:value.defaultId,connections};
}
function createStore(location=file){
 let writing=false;
 async function read(){try{return validate(JSON.parse(await fs.readFile(location,'utf8')));}catch(e){if(e.code==='ENOENT')return{version:1,revision:0,defaultId:'legacy-local',connections:[]};throw Error('Connection configuration unavailable');}}
 return {read,async selected(){const config=await read();if(config.defaultId==='legacy-local')return null;const found=config.connections.find(c=>c.id===config.defaultId);if(!found||found.enabled===false)return null;return modelConfig.ready(found)?modelConfig.select(found,found.model):structuredClone(found);},async save(input){
  if(writing)throw Error('CONNECTION_CONFLICT');writing=true;let temp;
  try{const config=validate(input),current=await read();if(config.revision!==current.revision)throw Error('CONNECTION_CONFLICT');if(config.revision===Number.MAX_SAFE_INTEGER)fail();config.revision++;temp=location+'.'+require('node:crypto').randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,location);temp=null;return config;}finally{if(temp)await fs.unlink(temp).catch(()=>{});writing=false;}
 }};
}
const store=createStore();
module.exports={...store,createStore,validate,isLoopback};
