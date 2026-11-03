'use strict';
(() => {
 const select=document.getElementById('chatModelSelect'), status=document.getElementById('chatModelStatus');
 let sequence=0, models=[];
 const encode=s=>s?JSON.stringify({providerId:s.providerId,model:s.model}):'';
 globalThis.chatModelSelector={
  capture(){return select.value?JSON.parse(select.value):null;},
  runtime(){const s=this.capture();const m=models.find(m=>m.providerId===s?.providerId&&m.model===s?.model);return m?{connectionId:m.providerId,modelName:m.model,contextLimit:m.contextLimit,capabilities:m.capabilities}:null;},
  reset(){sequence++;models=[];select.replaceChildren(new Option('Application default',''));select.disabled=true;},
  async load(saved,isCurrent=()=>true){
   const ticket=++sequence;select.disabled=true;
   try{
    const r=await fetch('/api/ai/models',{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();
    if(ticket!==sequence||!isCurrent())return;
    models=data.models;const defaultModel=models.find(m=>m.providerId===data.default?.providerId&&m.model===data.default?.model);select.replaceChildren(new Option(defaultModel?'Default: '+defaultModel.providerName+' / '+defaultModel.model:'Application default',''));const groups=new Map();
    for(const m of data.models){let group=groups.get(m.providerId);if(!group){group=document.createElement('optgroup');group.label=m.providerName;groups.set(m.providerId,group);select.appendChild(group);}group.appendChild(new Option(m.name+' — '+m.model,encode(m)));}
    const chosen=encode(saved);
    if(chosen&&!Array.from(select.options).some(o=>o.value===chosen)){select.appendChild(new Option('Unavailable saved model — choose another',chosen));status.textContent='Saved model unavailable. Choose another model before sending.';}
    else status.textContent='Switching models keeps this conversation and its history.';
    select.value=chosen;select.disabled=false;
   }catch{if(ticket===sequence&&isCurrent()){select.replaceChildren(new Option('Model list unavailable',encode(saved)));select.value=encode(saved);status.textContent='Model list unavailable. Reload to try again.';}}
  }
 };
 select.addEventListener('change',()=>{status.textContent='Selected: '+select.selectedOptions[0].textContent+'. Existing history is retained.';saveUserSettings();});
})();
