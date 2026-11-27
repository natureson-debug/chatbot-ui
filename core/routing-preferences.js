'use strict';
const {TASKS}=require('./model-router');
const POST=['return-default','keep-specialized','ask'];
const FALLBACK=['next-eligible','ask','never'];
const defaults=()=>({version:1,enabled:false,priorities:Object.fromEntries(TASKS.map(t=>[t,[]])),postTask:'return-default',fallback:'ask'});
const key=p=>JSON.stringify([p.providerId,p.model]);
function validate(input,catalog,{excludeMissing=false}={}){
 if(!input||input.version!==1||typeof input.enabled!=='boolean'||!POST.includes(input.postTask)||!FALLBACK.includes(input.fallback)||!input.priorities||Object.keys(input).some(k=>!['version','enabled','priorities','postTask','fallback'].includes(k))||Object.keys(input.priorities).some(k=>!TASKS.includes(k)))throw Error('Invalid routing preferences');
 const allowed=new Set(catalog.map(key)),out=defaults();Object.assign(out,{enabled:input.enabled,postTask:input.postTask,fallback:input.fallback});
 for(const task of TASKS){const list=input.priorities[task];if(!Array.isArray(list)||list.length>20)throw Error('Invalid priorities');const seen=new Set();for(const p of list){if(!p||typeof p.providerId!=='string'||typeof p.model!=='string'||Object.keys(p).some(k=>!['providerId','model'].includes(k))||seen.has(key(p)))throw Error('Invalid model');seen.add(key(p));if(!allowed.has(key(p))){if(excludeMissing)continue;throw Error('Model unavailable');}out.priorities[task].push({providerId:p.providerId,model:p.model});}}
 return out;
}
function load(db,user,catalog){const raw=db.prepare('SELECT routing_preferences FROM user_settings WHERE user_id=?').get(user)?.routing_preferences;if(!raw)return defaults();try{return validate(JSON.parse(raw),catalog,{excludeMissing:true});}catch{return defaults();}}
function save(db,user,value,catalog){const normalized=validate(value,catalog);db.prepare('INSERT INTO user_settings(user_id,routing_preferences) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET routing_preferences=excluded.routing_preferences').run(user,JSON.stringify(normalized));return normalized;}
async function handle(req,res,{db,user,authenticate,catalog}){
 const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 if(!user){reply(401,{error:'Authentication required'});return;}
 try{
  if(!['GET','POST'].includes(req.method)){reply(405,{error:'Method unavailable'});return;}
  let input;if(req.method==='POST'){
   if(!require('./restart-request').validRestartRequest({...req,headers:{...req.headers,'x-chatbot-action':req.headers['x-chatbot-action']==='routing-preferences'?'restart-ai':null}})){reply(403,{error:'Same-origin request required'});return;}
   let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)throw Error();}input=JSON.parse(body);
  }
  const models=await catalog();if(authenticate()?.id!==user.id){reply(401,{error:'Session expired'});return;}
  const preferences=req.method==='POST'?save(db,user.id,input,models):load(db,user.id,models);
  reply(200,{preferences,models,active:preferences.enabled&&require('./vision-routing').freeProviders().size>0,implementedTasks:['vision']});
 }catch{reply(400,{error:'Routing preferences unavailable or invalid'});}
}
module.exports={defaults,validate,load,save,handle};
