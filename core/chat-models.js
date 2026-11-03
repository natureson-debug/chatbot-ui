'use strict';
const models=require('./provider-models');
function choices(config, legacy) {
 const list=config.connections.filter(c=>c.enabled!==false&&c.capabilities.streaming===true&&models.ready(c));
 if(config.defaultId==='legacy-local'&&legacy)list.unshift(legacy);
 return list.flatMap(c=>models.list(c).filter(m=>m.enabled&&m.chat).map(m=>({providerId:c.id,providerName:c.name,model:m.id,
  name:m.name,contextLimit:m.id===c.model?c.contextLimit:null,capabilities:{...c.capabilities,...(m.capabilities||{}),
   ...(['openai-responses','deepseek-chat'].includes(c.adapter)?{thinking:false,vision:false,tools:false}:{})}})));
}
function defaultChoice(config, legacy) {
 if(config.defaultId==='legacy-local'){
  if(legacy)return {providerId:legacy.id,model:legacy.model};
  return null;
 }
 const c=config.connections.find(c=>c.id===config.defaultId);
 if(!c||c.enabled===false||c.capabilities.streaming!==true||!models.ready(c))return null;
 const m=models.list(c).find(m=>m.id===c.model&&m.enabled&&m.chat);
 return m?{providerId:c.id,model:m.id}:null;
}
function resolve(config, selection, legacy) {
 if(!selection||typeof selection!=='object'||typeof selection.providerId!=='string'||typeof selection.model!=='string')throw Error('MODEL_SELECTION_INVALID');
 const c=selection.providerId==='legacy-local'&&config.defaultId==='legacy-local'?legacy:config.connections.find(c=>c.id===selection.providerId);
 if(!c||c.enabled===false||c.capabilities.streaming!==true)throw Error('MODEL_SELECTION_UNAVAILABLE');
 return models.select(c,selection.model);
}
module.exports={choices,resolve,defaultChoice};
