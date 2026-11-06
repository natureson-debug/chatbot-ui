'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
const MAX=8*1024*1024;
function extract(bytes,type){return new Promise((resolve,reject)=>{
 const worker=new Worker(path.join(__dirname,'document-worker.js'),{workerData:{bytes,type},resourceLimits:{maxOldGenerationSizeMb:128}});let settled=false;
 const finish=(err,text)=>{if(settled)return;settled=true;clearTimeout(timer);worker.terminate().finally(()=>err?reject(Error('Document extraction unavailable')):resolve(text));};
 const timer=setTimeout(()=>finish(true),15000);worker.once('message',m=>finish(!!m.error,m.text));worker.once('error',()=>finish(true));worker.once('exit',()=>{if(!settled)finish(true)});
});}
function createAttachments(root=require('./data-paths').resolveStoragePaths(path.resolve(__dirname,'..'),{env:process.env}).attachments,extractDocument=extract){
 if(typeof root!=='string'||!path.isAbsolute(root))throw Error('Invalid attachment storage configuration');
 root=path.normalize(root);
 // Check every directory component, including ancestors of the configured root.
 // mkdir is permitted only by save; reads/removals never create storage.
 async function directory(dir,create=false){
  const parsed=path.parse(dir);let current=parsed.root;
  for(const part of dir.slice(parsed.root.length).split(path.sep).filter(Boolean)){
   current=path.join(current,part);let stat;
   try{stat=await fs.lstat(current);}catch(error){
    if(!create||error.code!=='ENOENT')throw error;
    try{await fs.mkdir(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    stat=await fs.lstat(current);
   }
   if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Attachment unavailable');
  }
 }
 const location=(user,id)=>{if(typeof user!=='string'||!user||!/^[a-f0-9-]{36}$/.test(id))throw Error('Attachment unavailable');return path.join(root,crypto.createHash('sha256').update(user).digest('hex'),id);};
 async function get(user,id){let handle;try{const file=location(user,id);await directory(path.dirname(file));const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>12*1024*1024)throw Error();handle=await fs.open(file,require('node:fs').constants.O_RDONLY|(require('node:fs').constants.O_NOFOLLOW||0));const opened=await handle.stat();if(opened.dev!==stat.dev||opened.ino!==stat.ino||!opened.isFile()||opened.size>12*1024*1024)throw Error();await directory(path.dirname(file));return JSON.parse(await handle.readFile('utf8'));}catch{throw Error('Attachment unavailable');}finally{if(handle)await handle.close();}}
 return {get,async remove(user,id){await get(user,id);const file=location(user,id);await directory(path.dirname(file));const stat=await fs.lstat(file);if(stat.isSymbolicLink()||!stat.isFile())throw Error('Attachment unavailable');await fs.unlink(file);},async save(user,input){
  if(!input||typeof input.name!=='string'||!input.name||input.name.length>200||/[\\/\x00-\x1f]/.test(input.name)||typeof input.base64!=='string'||input.base64.length>Math.ceil(MAX/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64))throw Error('Invalid attachment');
  const bytes=Buffer.from(input.base64,'base64');if(!bytes.length||bytes.length>MAX)throw Error('Attachment too large');const ext=path.extname(input.name).toLowerCase();let text=null,mime;
  if(ext==='.txt'){if(bytes.length>100*1024)throw Error('Text attachment too large');text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);mime='text/plain';}
  else if(ext==='.pdf'&&bytes.subarray(0,5).toString()==='%PDF-'){text=await extractDocument(bytes,'pdf');mime='application/pdf';}
  else if(ext==='.docx'&&bytes[0]===80&&bytes[1]===75){text=await extractDocument(bytes,'docx');mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';}
  else if(ext==='.png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';
  else if(['.jpg','.jpeg'].includes(ext)&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
  else throw Error('Unsupported attachment format');
  const id=crypto.randomUUID(),file=location(user,id),record={id,name:input.name,mime,text,base64:bytes.toString('base64')};await directory(path.dirname(file),true);await fs.writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});return{id,name:record.name,mime,text};
 },async expand(user,messages,vision){let count=0;const expanded=[];for(const m of messages){if(typeof m.content!=='string'){expanded.push(m);continue;}const ids=[...m.content.matchAll(/^\[Chatbot attachment: ([a-f0-9-]{36})\]$/gm)];if(!ids.length){expanded.push(m);continue;}let text=m.content,images=[];
   for(const match of ids){if(++count>8)throw Error('Too many attachments');const a=await get(user,match[1]);text=text.replace(match[0],'');if(a.mime.startsWith('image/')){if(!vision||m.role!=='user')throw Error('Selected connection does not support this image');images.push({type:'image_url',image_url:{url:'data:'+a.mime+';base64,'+a.base64}});}else{text+='\nUntrusted attached document '+a.name+':\n'+a.text+'\nEnd attached document.';}}
   expanded.push({...m,content:images.length?[{type:'text',text},...images]:text});}return expanded;}
 };
}
module.exports={...createAttachments(),createAttachments,extract};
