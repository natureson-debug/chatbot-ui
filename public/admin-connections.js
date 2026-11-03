'use strict';
(() => {
 const list=document.getElementById('providerList');
 const form=document.getElementById('providerForm');
 const status=document.getElementById('connectionStatus');
 const discoverStatus=document.getElementById('providerDiscoverStatus');
 const modelChoices=document.getElementById('providerModelChoices');

 let state={version:1,revision:0,defaultId:'legacy-local',connections:[]};
 let editingId=null;
 let presets=[],modelDraft=[];

 function setStatus(message,isError=false){
  status.textContent=message||'';
  status.classList.toggle('error',isError);
 }

 async function api(url,options={}){
  const headers=Object.assign({'Content-Type':'application/json','X-Chatbot-Action':'configure-connections'},options.headers||{});
  const response=await fetch(url,{...options,headers,credentials:'same-origin',cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
  return data;
 }

 async function load(){
  try{
   presets=await api('/api/admin/ai/connections/presets');
   const types=document.getElementById('providerType');types.replaceChildren();
   for(const p of presets){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;types.appendChild(option);}
   state=await api('/api/admin/ai/connections');
   render();
   setStatus('');
  }catch(error){setStatus('Provider settings unavailable: '+(error.message||'unknown error'),true);}
 }

 function render(){
  list.replaceChildren();
  for(const c of state.connections){
   const card=document.createElement('article');
   card.className='provider-card'+(c.id===state.defaultId?' default':'');

   const head=document.createElement('div');
   head.className='provider-card-head';

   const title=document.createElement('div');
   title.className='provider-card-title';
   const name=document.createElement('h3');
   name.textContent=c.name;
   const meta=document.createElement('p');
   meta.textContent=c.adapter+' · '+c.endpoint+' · '+(c.enabled===false?'disabled':'enabled');
   title.append(name,meta);

   const actions=document.createElement('div');
   actions.className='provider-card-actions';
   actions.append(button('Edit',()=>edit(c.id),'action-btn'));
   actions.append(button('Discover',()=>discover(c.id),'action-btn'));
   actions.append(button(c.enabled===false?'Enable':'Disable',()=>toggleEnabled(c),'action-btn'));
   actions.append(button('Set Default',()=>setDefault(c.id),'action-btn'));
   actions.append(button('Delete',()=>remove(c),'action-btn delete-btn'));

   head.append(title,actions);
   card.appendChild(head);
   list.appendChild(card);
  }
 }

 function button(label,onClick,className){
  const b=document.createElement('button');
  b.type='button';
  b.textContent=label;
  b.className=className||'';
  b.addEventListener('click',onClick);
  return b;
 }

 function openForm(provider=null){
  editingId=provider?provider.id:null;
  form.hidden=false;
  document.getElementById('providerId').value=provider?provider.id:'';
  document.getElementById('providerId').disabled=!!provider;
  document.getElementById('providerName').value=provider?provider.name:'';
  document.getElementById('providerType').value=provider?(provider.providerType|| (provider.adapter==='llama.cpp'?'llama.cpp':provider.adapter==='ollama'?'ollama':'custom')):'custom';
  document.getElementById('providerEndpoint').value=provider?provider.endpoint:'';
  const auth=provider?.credentialRef==='local-api-key'?'local-key':provider?.credentialRef?'env':'none';
  document.getElementById('providerAuthMode').value=auth;
  document.getElementById('providerCredentialRef').value=provider?.credentialRef&&provider.credentialRef!=='local-api-key'?provider.credentialRef:'';
  document.getElementById('providerModel').value=provider?provider.model:'';
  document.getElementById('providerBackendIdentity').value=provider?.backendModelIdentity??'';
  document.getElementById('providerTimeoutMs').value=provider?.timeoutMs||'';
  document.getElementById('providerEnabled').checked=provider?provider.enabled!==false:true;
  document.getElementById('providerPrivateNetwork').checked=provider?provider.privateNetwork===true:false;
  document.getElementById('providerAllowInsecureHttp').checked=provider?provider.allowInsecureHttp===true:false;
  document.getElementById('providerCapModels').checked=provider?provider.capabilities.models===true:true;
  document.getElementById('providerCapThinking').checked=provider?provider.capabilities.thinking===true:false;
  document.getElementById('providerCapVision').checked=provider?provider.capabilities.vision===true:false;
  document.getElementById('providerCapTools').checked=provider?provider.capabilities.tools===true:false;
  modelChoices.replaceChildren();
  discoverStatus.textContent='';
  modelDraft=provider?.models?structuredClone(provider.models):provider?[{id:provider.model,name:provider.model,enabled:true,chat:true,parameters:[...provider.parameters],defaults:{}}]:[];
  renderModels();updateType(false);
 }

 function closeForm(){
  form.hidden=true;
  editingId=null;
 }

 function collect(){
  const id=document.getElementById('providerId').value.trim();
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(id))throw Error('Provider ID must start with a letter and contain only lowercase letters, digits, and dashes.');
  const name=document.getElementById('providerName').value.trim();
  if(!name)throw Error('Display name is required.');
  const type=document.getElementById('providerType').value;
  const endpoint=document.getElementById('providerEndpoint').value.trim();
  if(!endpoint)throw Error('Base URL is required.');
  const auth=document.getElementById('providerAuthMode').value;
  const credentialRef=auth==='local-key'?'local-api-key':auth==='env'?document.getElementById('providerCredentialRef').value.trim():null;
  const model=document.getElementById('providerModel').value.trim();
  const backendModelIdentity=document.getElementById('providerBackendIdentity').value;
  if(backendModelIdentity&&!['llama.cpp-openai','llama.cpp'].includes(type))throw Error('Backend identity is only supported for llama.cpp. Clear it before changing provider type.');
  if(!model)throw Error('Default model is required.');
  if(typeof modelDraft!=='undefined'&&!modelDraft.length)throw Error('Add and explicitly approve at least one chat model.');
  const timeoutRaw=document.getElementById('providerTimeoutMs').value;
  const timeoutMs=timeoutRaw?Number(timeoutRaw):null;
  return {
   id,name,adapter:(typeof presets!=='undefined'?presets.find(p=>p.id===type)?.adapter:null)||type,
   ...(typeof presets!=='undefined'&&presets.some(p=>p.id===type)?{providerType:type}:{}),endpoint,credentialRef,model,timeoutMs,
   ...(typeof modelDraft!=='undefined'&&modelDraft.length?{models:structuredClone(modelDraft)}:{}),
   backendModelIdentity:backendModelIdentity||null,
   parameters:['temperature','max_tokens'],
   capabilities:{
    streaming:true,
    thinking:document.getElementById('providerCapThinking').checked,
    vision:document.getElementById('providerCapVision').checked,
    tools:document.getElementById('providerCapTools').checked,
    models:document.getElementById('providerCapModels').checked
   },
   contextLimit:typeof state!=='undefined'?state.connections.find(c=>c.id===id)?.contextLimit??null:null,
   privateNetwork:document.getElementById('providerPrivateNetwork').checked,
   allowInsecureHttp:document.getElementById('providerAllowInsecureHttp').checked,
   enabled:document.getElementById('providerEnabled').checked
  };
 }

 async function saveProvider(event){
  event.preventDefault();
  try{
   const provider=collect();
   const prior=structuredClone(state);
   const existing=editingId?state.connections.find(c=>c.id===editingId):null;
   if(existing){
    Object.assign(existing,provider);
   }else{
    if(state.connections.some(c=>c.id===provider.id))throw Error('A provider with this ID already exists. Edit the existing provider instead.');
    state.connections.push(provider);
   }
   try{
    await save();
    closeForm();
    render();
    setStatus('Provider saved.');
   }catch(error){
    state=prior;
    throw error;
   }
  }catch(error){setStatus('Save failed: '+(error.message||'unknown error'),true);}
 }

 async function save(){
  const saved=await api('/api/admin/ai/connections',{method:'POST',body:JSON.stringify(state)});
  state=saved;
 }

 async function toggleEnabled(provider){
  provider.enabled=provider.enabled===false;
  try{await save();render();setStatus(provider.enabled?'Provider enabled.':'Provider disabled.');}catch(error){setStatus('Update failed: '+error.message,true);provider.enabled=!provider.enabled;}
 }

 async function setDefault(id){
  state.defaultId=id;
  try{await save();render();setStatus('Default provider updated.');}catch(error){setStatus('Update failed: '+error.message,true);}
 }

 async function remove(provider){
  const confirmed=typeof terminalConfirm==='function'?await terminalConfirm(`Delete provider "${provider.name}"? This does not stop or change any running inference service.`,'DELETE PROVIDER'):window.confirm(`Delete provider "${provider.name}"?`);
  if(!confirmed)return;
  state.connections=state.connections.filter(c=>c.id!==provider.id);
  if(state.defaultId===provider.id)state.defaultId='legacy-local';
  try{await save();render();setStatus('Provider deleted.');}catch(error){setStatus('Delete failed: '+error.message,true);}
 }

 function edit(id){
  const provider=state.connections.find(c=>c.id===id);
  if(provider)openForm(provider);
 }

 async function discover(id){
  discoverStatus.textContent='Discovering models...';
  try{
   const result=await api('/api/admin/ai/connections/'+encodeURIComponent(id)+'/check',{method:'POST',body:'{}'});
   const ids=(result.models||[]).map(m=>m.id);
   modelChoices.replaceChildren();
   for(const modelId of ids){
    const option=document.createElement('option');
    option.value=modelId;
    modelChoices.appendChild(option);
   }
   discoverStatus.textContent='Discovered: '+(ids.join(', ')||'(none)')+'. Capability classification is unknown for OpenAI-compatible model lists.';
   // Discovery is suggestions only: no approvals, deletions or defaults change.
  }catch(error){discoverStatus.textContent='Discovery failed: '+(error.message||'unknown error');}
 }


 function updateType(prefill){
  const p=presets.find(p=>p.id===document.getElementById('providerType').value);if(!p)return;
  if(prefill){document.getElementById('providerEndpoint').value=p.endpoint;document.getElementById('providerAuthMode').value=p.cloud?'env':'none';}
  document.getElementById('providerProtocolStatus').textContent=['openai-responses','anthropic-messages','gemini-native'].includes(p.adapter)?'Configuration and discovery only. Native inference is not implemented in MP-05A.':'Uses the existing adapter; individual model compatibility requires qualification.';
  document.getElementById('providerBackendIdentity').closest('.field-group').querySelector('small').hidden=p.adapter!=='llama.cpp';
  document.getElementById('providerBackendIdentity').disabled=p.adapter!=='llama.cpp';
  if(prefill&&p.adapter!=='llama.cpp')document.getElementById('providerBackendIdentity').value='';
  for(const id of ['providerPrivateNetwork','providerAllowInsecureHttp']){document.getElementById(id).disabled=p.cloud;if(p.cloud&&prefill)document.getElementById(id).checked=false;}
  updateAuth();
 }
 function updateAuth(){document.getElementById('providerCredentialRef').disabled=document.getElementById('providerAuthMode').value!=='env';}
 function renderModels(){
  const root=document.getElementById('providerConfiguredModels');root.replaceChildren();
  for(const m of modelDraft){
   const row=document.createElement('fieldset');row.className='provider-model-row';const legend=document.createElement('legend');legend.textContent=m.id;row.appendChild(legend);
   const input=(labelText,value,type,onchange)=>{const label=document.createElement('label');label.textContent=labelText;const field=document.createElement('input');field.type=type;if(type==='checkbox')field.checked=value;else field.value=value;field.addEventListener('change',()=>onchange(type==='checkbox'?field.checked:field.value));label.appendChild(field);row.appendChild(label);return field;};
   input('Display name',m.name,'text',v=>m.name=v);
   input('Enabled',m.enabled,'checkbox',v=>m.enabled=v);
   input('Administrator-approved chat model',m.chat,'checkbox',v=>m.chat=v);
   for(const capability of ['thinking','vision','tools'])input('Supports '+capability,m.capabilities?.[capability]??document.getElementById('providerCap'+capability[0].toUpperCase()+capability.slice(1)).checked,'checkbox',v=>{m.capabilities={...(m.capabilities||{}),[capability]:v};});
   for(const parameter of ['temperature','max_tokens']){
    input('Supports '+parameter,m.parameters.includes(parameter),'checkbox',v=>{m.parameters=v?[...new Set([...m.parameters,parameter])]:m.parameters.filter(p=>p!==parameter);if(!v)delete m.defaults[parameter];renderModels();});
    const field=input(parameter+' default (optional)',m.defaults[parameter]??'','number',v=>{if(v==='')delete m.defaults[parameter];else m.defaults[parameter]=Number(v);});field.disabled=!m.parameters.includes(parameter);field.step=parameter==='temperature'?'0.1':'1';
   }
   row.appendChild(button('Use as default',()=>{document.getElementById('providerModel').value=m.id;},'action-btn'));
   row.appendChild(button('Remove model',()=>{modelDraft=modelDraft.filter(item=>item!==m);renderModels();},'action-btn'));root.appendChild(row);
  }
 }
 document.getElementById('addProviderModel').addEventListener('click',()=>{
  const field=document.getElementById('providerNewModel'),id=field.value.trim();if(!id||modelDraft.some(m=>m.id===id)){setStatus('Enter a unique model ID.',true);return;}
  modelDraft.push({id,name:id,enabled:true,chat:false,parameters:[],defaults:{},capabilities:{thinking:false,vision:false,tools:false}});field.value='';renderModels();
 });
 document.getElementById('providerType').addEventListener('change',()=>updateType(true));
 document.getElementById('providerAuthMode').addEventListener('change',updateAuth);
 document.getElementById('newProvider').addEventListener('click',()=>openForm(null));
 document.getElementById('cancelProvider').addEventListener('click',closeForm);
 document.getElementById('saveProvider').addEventListener('click',saveProvider);
 document.getElementById('discoverProvider').addEventListener('click',()=>{
  const id=document.getElementById('providerId').value.trim();
  if(!id){discoverStatus.textContent='Enter a provider ID first.';return;}
  if(!state.connections.some(c=>c.id===id)){discoverStatus.textContent='Save this provider before discovering models.';return;}
  discover(id);
 });

 load();
})();
