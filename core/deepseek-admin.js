'use strict';
const {performance}=require('node:perf_hooks');
const locks=new Set();
async function handle({req,res,db,connections,authenticate,providers,credentials=require('./protected-credentials'),log=()=>{}}){
 const match=/^\/api\/admin\/ai\/connections\/([a-z][a-z0-9-]{0,47})\/(credential|test)$/.exec(req.url);if(!match)return false;
 const reply=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 const admin=authenticate();if(!admin||admin.is_admin!==1){log('AUTH_ADMIN_ACCESS_DENIED',{actorId:admin?.id,metadata:{resource:'admin_api',reason:admin?'not_administrator':'unauthenticated'}});reply(admin?403:401,{error:'Administrator access required'});return true;}
 const authorized=()=>{
  const current=authenticate(),valid=current?.id===admin.id&&current.is_admin===1;
  if(!valid)log('AUTH_ADMIN_ACCESS_DENIED',{actorId:admin.id,metadata:{resource:'admin_api',reason:'session_revoked'}});
  return valid;
 };
 const id=match[1],action=match[2];let locked=false,admission,testStartedAt=null;
 const accounting=require('./openai-usage').forProvider('deepseek');
 try{
  if(req.method!=='GET'&&!require('./restart-request').validRestartRequest({...req,headers:{...req.headers,'x-chatbot-action':req.headers['x-chatbot-action']==='configure-connections'?'restart-ai':null}})){reply(403,{error:'Same-origin intent required'});return true;}
  let input={};if(req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw Error();}input=JSON.parse(body);}
  if(!authorized()){reply(401,{error:'Session no longer authorized'});return true;}
  const config=await connections.read(),c=config.connections.find(c=>c.id===id);
  if(!c||c.adapter!=='deepseek-chat'||c.credentialRef!=='protected:'+id){reply(400,{error:'Save a GUI-managed DeepSeek provider first'});return true;}
  if(!authorized()){reply(401,{error:'Session no longer authorized'});return true;}
  if(action==='credential'&&req.method==='GET'){const configured=await credentials.configured(c);if(!authorized()){reply(401,{error:'Session no longer authorized'});return true;}reply(200,{configured});return true;}
  if(!['POST','DELETE'].includes(req.method)){reply(405,{error:'Method not allowed'});return true;}
  if(locks.has(id)){reply(409,{error:'Provider operation in progress'});return true;}locks.add(id);locked=true;
  if(action==='credential'){
   if(req.method==='POST')await credentials.save(c,input.apiKey,authorized);else {if(c.enabled!==false){c.enabled=false;await connections.save(config);}await credentials.remove(c,authorized);}
   if(!authorized()){reply(401,{error:'Session no longer authorized'});return true;}
   log('PROVIDER_CONFIGURATION_CHANGED',{actorId:admin.id,providerId:id,metadata:{change:req.method==='POST'?'credential_saved':'credential_removed'}});
   reply(200,{configured:req.method==='POST'});return true;
  }
  if(req.method!=='POST'||input.confirmPaidTest!==true){reply(400,{error:'Explicit confirmation of paid test required'});return true;}
  testStartedAt=performance.now();
  log('PROVIDER_CONNECTION_TEST_STARTED',{actorId:admin.id,providerId:id,metadata:{diagnostic:true}});
  if(!await credentials.configured(c))throw Error();
  const selected=require('./provider-models').select({...c,enabled:true},input.model||c.model);
  admission=accounting.admit(db,{provider:selected,userId:admin.id,chatId:'diagnostic',revision:0,diagnostic:true,authorize:authorized});
  let httpStatus=null,terminal=null,usage=null;
  const adapter=providers||require('./provider-adapter').createAdapter({onDiagnostics:event=>{httpStatus=event.httpStatus;}});
  const result=await adapter.chat({...selected,timeoutMs:8000},{messages:[{role:'user',content:'Reply with OK.'}],max_tokens:16},{signal:AbortSignal.timeout(10000),maxOutputTokens:Math.min(16,admission.maxOutput),beforeSend:()=>{if(!authorized()||!accounting.settings(db).enabled)throw Error();},onProgress:event=>{if(event.status)terminal=event.status;if(event.usage)usage=event.usage;accounting.observe(db,admission.id,event);}});
  // Consume normalized events but never return generated text or upstream details.
  for await(const ignored of result.body){}
  const durationMs=Math.max(0,Math.round(performance.now()-testStartedAt));
  if(!authorized()){
   log('PROVIDER_CONNECTION_TEST_FAILED',{actorId:admin.id,providerId:id,metadata:{reason:'operation_failed',durationMs}});
   reply(401,{error:'Session no longer authorized'});return true;
  }
  if(terminal==='completed')log('PROVIDER_CONNECTION_TEST_COMPLETED',{actorId:admin.id,providerId:id,metadata:{durationMs}});
  else log('PROVIDER_CONNECTION_TEST_FAILED',{actorId:admin.id,providerId:id,metadata:{reason:'provider_unavailable',durationMs}});
  reply(200,{success:terminal==='completed',httpStatus,model:selected.model,responseTimeMs:durationMs,usage,status:terminal,error:terminal==='completed'?null:'DeepSeek test did not complete successfully'});
 }catch{if(testStartedAt!==null)log('PROVIDER_CONNECTION_TEST_FAILED',{actorId:admin?.id,providerId:match[1],metadata:{
  reason:'operation_failed',durationMs:Math.min(10000000,Math.max(0,Math.round(performance.now()-testStartedAt)))
 }});reply(400,{error:'DeepSeek operation unavailable. Check credential, approval and safeguards.'});}
 finally{if(admission)accounting.observe(db,admission.id,{status:'failed'});if(locked)locks.delete(id);}
 return true;
}
module.exports={handle};
