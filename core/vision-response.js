'use strict';
// Existing response_request_id unique index provides durable one-attempt-per-image binding.
function reserve(db,user,input,provider,authorize){
 db.exec('BEGIN IMMEDIATE');try{
  if(!authorize())throw Error();
  const chat=db.prepare('SELECT revision FROM chats WHERE id=? AND user_id=?').get(input.chatId,user);
  if(!chat||chat.revision!==input.expectedRevision)throw Error();
  const content=input.messages.at(-1).content,ids=require('./image-attachments').references(content);
  if(ids.length!==1)throw Error();
  const image=db.prepare("SELECT message_id FROM image_attachments WHERE id=? AND user_id=? AND chat_id=? AND state='bound'").get(ids[0],user,input.chatId);
  if(!image||!db.prepare("SELECT id FROM messages WHERE id=? AND chat_id=? AND role='user' AND content=?").get(image.message_id,input.chatId,content))throw Error();
  const requestId='vision:'+image.message_id;
  const result=db.prepare("INSERT INTO messages(chat_id,role,content,telemetry_json,response_status,response_request_id) VALUES(?,'assistant','',?,'interrupted',?)").run(input.chatId,JSON.stringify({model:provider.model,provider:provider.name}),requestId);
  db.exec('COMMIT');return result.lastInsertRowid;
 }catch{db.exec('ROLLBACK');throw require('./vision-routing').failure('VISION_REQUEST_ALREADY_HANDLED_OR_INVALID');}
}
async function serve({db,req,res,user,input,routed,providers,authorize,images,skills}){
 const controller=new AbortController();const closed=()=>controller.abort();res.once('close',closed);
 let id,reader,text='',telemetry={},completed=false;
 try{
  // Ownership/reference validation precedes inference and is repeated by reservation.
  let expanded=await images.expand(user,input.chatId,input.messages);
  if(expanded.some(m=>typeof m.content==='string'&&m.content.includes('[Chatbot attachment:')))expanded=await require('./attachments').expand(user,expanded,false);
  id=reserve(db,user,input,routed.provider,authorize);
  const messages=skills?[...skills,...expanded]:expanded;
  if(!authorize()||controller.signal.aborted||!await routed.revalidate())throw Error();
  const upstream=await providers.chat(routed.provider,{...input,messages},{signal:controller.signal});if(!upstream.ok)throw Error();
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Chat-Persistence':'server','X-Chat-Model':encodeURIComponent(routed.provider.model),'X-Chat-Provider':encodeURIComponent(routed.provider.name),'X-Chat-Routing':routed.notice,'X-Chat-Context':String(routed.provider.contextLimit??'unknown')});
  reader=upstream.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let buffer='';
  for(;;){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});if(buffer.length>1048576)throw Error();let end;
   while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data)continue;
    if(data==='[DONE]'){completed=true;continue;}if(completed)throw Error();const chunk=JSON.parse(data);if(chunk.error)throw Error();text+=chunk.choices?.[0]?.delta?.content||'';if(text.length>1000000)throw Error();if(chunk.telemetry)telemetry=chunk.telemetry;
    if(!res.destroyed)res.write('data: '+JSON.stringify(chunk)+'\n\n');
   }if(done)break;
  }
  if(!completed||buffer.trim())throw Error();
  db.prepare('UPDATE messages SET content=?,telemetry_json=?,response_status=? WHERE id=?').run(text,JSON.stringify({...telemetry,model:routed.provider.model,provider:routed.provider.name}),'completed',id);
  if(!res.destroyed)res.end('data: '+JSON.stringify({responseStatus:'completed'})+'\n\ndata: [DONE]\n\n');
 }catch(e){if(id)db.prepare('UPDATE messages SET content=?,response_status=? WHERE id=?').run(text,controller.signal.aborted?'cancelled':'failed',id);
  if(!res.destroyed){if(!res.headersSent){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Vision request could not complete. Reload the conversation before trying again.',code:e.code||'VISION_REQUEST_FAILED'}));}else res.end('data: '+JSON.stringify({error:'Vision response interrupted',responseStatus:'interrupted'})+'\n\n');}
 }finally{controller.abort();if(reader){try{await reader.cancel();}catch{/* Already errored/cancelled streams need no further action. */}finally{reader.releaseLock();}}res.off('close',closed);}
}
module.exports={reserve,serve};
