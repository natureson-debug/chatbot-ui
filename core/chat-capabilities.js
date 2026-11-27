'use strict';
async function handle(req,res,{user,authenticate,read,legacy,permitted,imagePath,automaticVision,discover=(c,m)=>require('./provider-adapter').capabilities(c,m)}){
 const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 if(!user){reply(401,{error:'Authentication required'});return;}
 try{
  const url=new URL(req.url,'http://localhost'),selection={providerId:url.searchParams.get('providerId'),model:url.searchParams.get('model')};
  const config=await read(),c=selection.providerId==='legacy-local'&&config.defaultId==='legacy-local'?legacy():config.connections.find(c=>c.id===selection.providerId);
  const selected=require('./chat-models').resolve(config,selection,c?.id==='legacy-local'?c:null);
  if(!permitted(selected))throw Error();
  const current=authenticate();if(!current||current.id!==user.id){reply(401,{error:'Session no longer authorized'});return;}
  let observation=require('./model-capabilities').cachedCapabilities(c,selection.model);
  if(!observation){try{observation=await discover(c,selection.model);}catch{}}
  const fresh=!!observation;
  observation=observation||require('./model-capabilities').cachedCapabilities(c,selection.model,Date.now(),true);
  if((await read()).revision!==config.revision)throw Error();
  let automaticImageInput=false;if(automaticVision){try{automaticImageInput=!!(await automaticVision(selection));}catch{}}
  const finalUser=authenticate();if(!finalUser||finalUser.id!==user.id){reply(401,{error:'Session no longer authorized'});return;}
  reply(200,{...selection,checkedAt:observation?.checkedAt??null,freshness:fresh?'fresh':observation?'stale':'unavailable',
   capabilities:observation?.capabilities??Object.fromEntries(['text','vision','documents','tools'].map(k=>[k,{state:'unknown',scope:k==='documents'?'application':'native',method:'not-checked',verifiedAt:null}])),
   automaticImageInput,imageInputAvailable:fresh&&observation?.capabilities.vision.state==='verified'&&selected.adapter==='ollama',imageMaxBytes:require('./image-attachments').limits().max});
 }catch{reply(404,{error:'Model capabilities unavailable'});}
}
module.exports={handle};
