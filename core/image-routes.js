'use strict';
async function handle(req,res,{user,authorize,images,vision}){
 const reply=(n,d)=>{res.writeHead(n,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(d));};
 if(!user){reply(401,{error:'Authentication required'});return;}
 try{
  const match=/^\/api\/images\/([a-f0-9-]{36})$/.exec(req.url);
  if(req.method==='GET'&&match){const a=await images.get(user.id,match[1]);if(!authorize())throw Error();res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});res.end(Buffer.from(a.base64,'base64'));return;}
  if(!require('./restart-request').validRestartRequest({...req,headers:{...req.headers,'x-chatbot-action':req.headers['x-chatbot-action']==='extensions'?'restart-ai':null}}))throw Error();
  if(req.method==='DELETE'&&match){if(!authorize())throw Error();await images.remove(user.id,match[1]);reply(200,{deleted:true});return;}
  if(req.method!=='POST'||req.url!=='/api/images'){reply(405,{error:'Method unavailable'});return;}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>Math.ceil(require('./image-attachments').limits().max/3)*4+4096)throw Error();}
  const input=JSON.parse(body);await vision(input.selection);if(!authorize())throw Error();reply(201,await images.save(user.id,input,authorize));
 }catch{reply(400,{error:'Image unavailable: check format, size, quota, conversation and verified vision support.'});}
}
async function authorizeVision(connections,providers,selection){
 const config=await connections.read();const chosen=selection??require('./chat-models').defaultChoice(config,null);
 const selected=require('./chat-models').resolve(config,chosen,null);if(selected.adapter!=='ollama')throw Error('Image adapter unavailable');
 const base=config.connections.find(c=>c.id===selected.id);const caps=await providers.capabilities(base,selected.model);
 if(caps.capabilities.vision.state!=='verified'||(await connections.read()).revision!==config.revision)throw Error('Vision not verified');
 return {...selected,capabilities:{...selected.capabilities,vision:true}};
}
module.exports={handle,authorizeVision};
