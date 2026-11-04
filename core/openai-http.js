'use strict';
const accounting=require('./openai-usage');
// Only the authenticated HTTP coordinator admits accountable cloud attempts.
async function serve({db,req,res,user,provider,input,providers,authorize}){
 const family=provider.adapter==='deepseek-chat'?'deepseek':'openai',label=family==='deepseek'?'DeepSeek':'OpenAI';
 const usage=accounting.forProvider(family);
 let admission,reader,failureStatus='interrupted';const controller=new AbortController();
 const disconnected=()=>{if(!res.writableFinished)controller.abort();};res.on('close',disconnected);
 try{
  admission=usage.admit(db,{provider,userId:user.id,chatId:input.chatId,revision:input.expectedRevision,authorize});
  const response=await providers.chat(provider,input,{signal:controller.signal,maxOutputTokens:admission.maxOutput,
   beforeSend:()=>{if((process.env[usage.gate]!=='1'&&!(family==='deepseek'&&provider.credentialRef==='protected:'+provider.id))||!usage.settings(db).enabled||!authorize())throw Error('Provider authorization changed');},
   onProgress:event=>usage.observe(db,admission.id,{...event,providerName:provider.name})});
  if(res.destroyed)return;
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Chat-Persistence':'server','X-Chat-Model':encodeURIComponent(provider.model),'X-Chat-Provider':encodeURIComponent(provider.name),'X-Chat-Context':'unknown'});
  reader=response.body.getReader();
  for(;;){const item=await reader.read();if(item.done||res.destroyed)break;res.write(Buffer.from(item.value));}
  if(!res.destroyed)res.end();
 }catch(error){
  failureStatus='failed';
  if(!res.destroyed){
   const code=typeof error.code==='string'&&/^(OPENAI_|DEEPSEEK_|CHAT_|SESSION_)/.test(error.code)?error.code:family.toUpperCase()+'_REQUEST_FAILED';
   if(!res.headersSent){res.writeHead(error.status||503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:label+' request unavailable: '+code,code}));}
   else res.end('data: '+JSON.stringify({error:label+' response interrupted.',responseStatus:'interrupted'})+'\n\n');
  }
 }finally{
  controller.abort();if(reader){try{await reader.cancel();}finally{reader.releaseLock();}}
  if(admission)usage.observe(db,admission.id,{status:res.destroyed?'cancelled':failureStatus});
  res.off('close',disconnected);
 }
}
module.exports={serve};
