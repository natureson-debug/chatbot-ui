'use strict';
const nativePending=new Set(['openai-responses','anthropic-messages','gemini-native']);
const ready=c=>!nativePending.has(c.adapter);
function list(c){return c.models??[{id:c.model,name:c.model.split(/[\\/]/).pop().replace(/\.gguf$/i,''),enabled:true,chat:true,parameters:c.parameters??[],defaults:{}}];}
function select(c,id){
 const model=list(c).find(m=>m.id===id&&m.enabled&&m.chat);
 if(!model||c.enabled===false||!ready(c))throw Error('MODEL_SELECTION_UNAVAILABLE');
 return {...structuredClone(c),model:model.id,modelDisplayName:model.name,parameters:[...model.parameters],modelDefaults:{...model.defaults},capabilities:{...c.capabilities,...(model.capabilities||{})},contextLimit:id===c.model?c.contextLimit:null,
  // A connection-level backend mapping only qualifies its original default model.
  ...(id!==c.model?{backendModelIdentity:undefined}:{})};
}
function validateModels(models,connection){
 if(models===undefined)return undefined;
 if(!Array.isArray(models)||models.length<1||models.length>100)throw Error('Invalid configured model list');
 const ids=new Set();
 const result=models.map(m=>{
  if(!m||typeof m.id!=='string'||!m.id.trim()||m.id.length>512||/[\x00-\x1f\x7f]/.test(m.id)||ids.has(m.id))throw Error('Invalid or duplicate model ID');ids.add(m.id);
  if(typeof m.name!=='string'||!m.name.trim()||m.name.length>120||typeof m.enabled!=='boolean'||typeof m.chat!=='boolean')throw Error('Invalid model display name or approval');
  const parameters=m.parameters??connection.parameters;
  if(!Array.isArray(parameters)||parameters.some(p=>!['temperature','max_tokens'].includes(p)))throw Error('Unsupported model parameter');
  const defaults=m.defaults??{};
  if(!defaults||typeof defaults!=='object'||Array.isArray(defaults)||Object.keys(defaults).some(k=>!parameters.includes(k)))throw Error('Invalid model defaults');
  if(defaults.temperature!==undefined&&(typeof defaults.temperature!=='number'||!Number.isFinite(defaults.temperature)||defaults.temperature<0||defaults.temperature>2))throw Error('Invalid model temperature');
  if(defaults.max_tokens!==undefined&&(!Number.isSafeInteger(defaults.max_tokens)||defaults.max_tokens<1||defaults.max_tokens>32768))throw Error('Invalid model token limit');
  if(m.capabilities!==undefined&&(!m.capabilities||typeof m.capabilities!=='object'||Array.isArray(m.capabilities)||Object.entries(m.capabilities).some(([k,v])=>!['thinking','vision','tools'].includes(k)||typeof v!=='boolean')))throw Error('Invalid model capabilities');
  return {...(m.capabilities?{capabilities:{...m.capabilities}}:{}),id:m.id,name:m.name,enabled:m.enabled,chat:m.chat,parameters:[...new Set(parameters)],defaults:{...defaults}};
 });
 if(!result.some(m=>m.id===connection.model&&m.enabled&&m.chat))throw Error('Default model must be an enabled, approved chat model');
 return result;
}
module.exports={ready,list,select,validateModels};
