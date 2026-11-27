'use strict';
const {randomUUID}=require('node:crypto');
const references=text=>[...String(text).matchAll(/\[Chatbot image: ([a-f0-9-]{36})\]/g)].map(m=>m[1]);
function limits(env=process.env){const number=(key,fallback,max)=>{if(env[key]===undefined)return fallback;const n=Number(env[key]);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Invalid image limits');return n;};return {max:number('CHATBOT_IMAGE_MAX_BYTES',10*1024*1024,10*1024*1024),quota:number('CHATBOT_IMAGE_QUOTA_BYTES',100*1024*1024,1024*1024*1024),count:100};}
function transaction(db,fn){const nested=db.isTransaction;db.exec(nested?'SAVEPOINT image_write':'BEGIN IMMEDIATE');try{const r=fn();db.exec(nested?'RELEASE image_write':'COMMIT');return r;}catch(e){db.exec(nested?'ROLLBACK TO image_write; RELEASE image_write':'ROLLBACK');throw e;}}
function bind(db,user,chat,message,role,content,now=Date.now()){
 const ids=references(content);if(!ids.length)return;if(ids.length!==1||role!=='user')throw Error('One image per user message required');
 const r=db.prepare("UPDATE image_attachments SET message_id=?,state='bound' WHERE id=? AND user_id=? AND chat_id=? AND state='pending' AND expires_at>?").run(message,ids[0],user,chat,now);if(r.changes!==1)throw Error('Image unavailable for this conversation');
}
function createImages(db,{storage=require('./attachments'),decode=require('./image-codec').decode,policy=limits(),now=Date.now}={}){
 let cleaning=null,uploads=0;const active=new Set();
 const owns=(user,chat)=>!!db.prepare('SELECT id FROM chats WHERE id=? AND user_id=?').get(chat,user);
 const row=(user,id)=>db.prepare('SELECT * FROM image_attachments WHERE id=? AND user_id=?').get(id,user);
 async function cleanup(){if(cleaning)return cleaning;cleaning=(async()=>{
  const rows=transaction(db,()=>{const candidates=db.prepare("SELECT id FROM image_attachments WHERE chat_id IS NULL OR (state='bound' AND message_id IS NULL) OR (state IN ('uploading','pending') AND expires_at<=?)").all(now());for(const r of candidates)if(!active.has(r.id))db.prepare("UPDATE image_attachments SET state='deleting' WHERE id=?").run(r.id);return db.prepare("SELECT * FROM image_attachments WHERE state='deleting' LIMIT 100").all().filter(r=>!active.has(r.id));});
  for(const r of rows){try{await storage.purge(r.user_id,r.storage_id);db.prepare("DELETE FROM image_attachments WHERE id=? AND state='deleting'").run(r.id);}catch{/* Retain row and quota for retry. */}}
 })().finally(()=>cleaning=null);return cleaning;}
 return {cleanup,async save(user,input,authorize=()=>true){
  if(uploads>=2)throw Error('Image processing busy');uploads++;let id;
  try{
   if(!input||!owns(user,input.chatId)||typeof input.name!=='string'||!input.name||input.name.length>200||/[\\/\x00-\x1f]/.test(input.name)||! /\.(png|jpe?g|webp)$/i.test(input.name)||typeof input.base64!=='string'||input.base64.length>Math.ceil(policy.max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))throw Error('Invalid image upload');
   const bytes=Buffer.from(input.base64,'base64');require('./image-codec').validate(bytes,policy.max);await cleanup();
   id=randomUUID();transaction(db,()=>{if(!authorize()||!owns(user,input.chatId))throw Error('Unauthorized');const q=db.prepare('SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM image_attachments WHERE user_id=?').get(user);if(q.n>=policy.count||q.bytes+policy.max>policy.quota)throw Error('Image quota exceeded');db.prepare("INSERT INTO image_attachments VALUES(?,?,?,NULL,? ,?,'image/png',?,0,0,?,?,'uploading')").run(id,user,input.chatId,id,input.name,policy.max,now(),now()+3600000);});
   active.add(id);const image=await decode(bytes,policy.max);if(!authorize())throw Error('Unauthorized');
   await storage.save(user,{name:id+'.png',base64:image.bytes.toString('base64')},id);
   transaction(db,()=>{if(!authorize()||!owns(user,input.chatId))throw Error('Unauthorized');const r=db.prepare("UPDATE image_attachments SET bytes=?,width=?,height=?,state='pending' WHERE id=? AND state='uploading'").run(image.bytes.length,image.width,image.height,id);if(r.changes!==1)throw Error('Upload expired');});
   return {id,name:input.name,mime:'image/png',width:image.width,height:image.height};
  }catch(e){if(id)db.prepare("UPDATE image_attachments SET state='deleting' WHERE id=? AND state='uploading'").run(id);active.delete(id);await cleanup();throw Error('Image upload rejected: invalid content, limits, quota or authorization');}finally{active.delete(id);uploads--;}
 },async get(user,id,chat){const r=row(user,id);if(!r||!['pending','bound'].includes(r.state)||!owns(user,r.chat_id)||(chat&&r.chat_id!==chat)||(r.state==='pending'&&r.expires_at<=now()))throw Error('Image unavailable');const value=await storage.get(user,r.storage_id);const current=row(user,id);if(!current||!['pending','bound'].includes(current.state)||!owns(user,current.chat_id))throw Error('Image unavailable');return {...value,name:r.name};},
 async remove(user,id){transaction(db,()=>{const r=row(user,id);if(!r||r.state==='bound')throw Error('Bound image cannot be removed');db.prepare("UPDATE image_attachments SET state='deleting' WHERE id=?").run(id);});await cleanup();},
 async expand(user,chat,messages){if(!owns(user,chat))throw Error('Conversation unavailable');const result=[];let imageCount=0,totalBytes=0;
  for(const m of messages){const ids=references(m.content);if(!ids.length){result.push(m);continue;}if(ids.length!==1||m.role!=='user')throw Error('One image per user message required');const r=row(user,ids[0]);if(!r||r.state!=='bound'||r.chat_id!==chat||!db.prepare('SELECT id FROM messages WHERE id=? AND chat_id=? AND role=? AND content=?').get(r.message_id,chat,'user',m.content))throw Error('Image message unavailable');if(++imageCount>4||(totalBytes+=r.bytes)>20*1024*1024)throw Error('Image history limit exceeded');const a=await this.get(user,ids[0],chat);result.push({...m,content:[{type:'text',text:m.content.replace(/\[Chatbot image: [a-f0-9-]{36}\]/g,'')},{type:'image_url',image_url:{url:'data:image/png;base64,'+a.base64}}]});}
  return result;
 }};
}
const stores=new WeakMap();
function getImages(db){if(!stores.has(db)){const store=createImages(db);stores.set(db,store);const timer=setInterval(()=>store.cleanup().catch(()=>{}),60000);timer.unref();void store.cleanup().catch(()=>{});}return stores.get(db);}
module.exports={createImages,getImages,bind,references,limits};
