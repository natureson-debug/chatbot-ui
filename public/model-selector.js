'use strict';
function createChatCapabilities({document,fetch,setTimer=setTimeout,clearTimer=clearTimeout}){
 const footer=document.querySelector('footer'),input=document.getElementById('attachment');
 const root=document.createElement('div');root.className='chat-capabilities';root.setAttribute('role','status');root.setAttribute('aria-label','Selected model capabilities');
 footer.before(root);
 const css=document.createElement('link');css.rel='stylesheet';css.href='/chat-capabilities.css';document.head.appendChild(css);
 let sequence=0,controller=null,timer=null,imageAllowed=false,imageMax=10*1024*1024,last=null;
 const state=v=>['verified','unsupported','unknown'].includes(v)?v:'unknown';
 function render(data){
  root.replaceChildren();imageAllowed=data?.freshness!=='stale'&&(data?.automaticImageInput===true||data?.imageInputAvailable===true&&data?.capabilities?.vision?.state==='verified');
  imageMax=Number.isSafeInteger(data?.imageMaxBytes)?data.imageMaxBytes:10*1024*1024;
  input.accept=imageAllowed?'.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp':'.txt,.pdf,.docx';
  const label=document.querySelector('label[for="attachment"]');if(label)label.title=imageAllowed?'Attach text, PDF, DOCX, PNG, JPEG or WebP':'Attach text, PDF or DOCX; image input unavailable or unverified';
  if(!imageAllowed&&/\.(png|jpe?g|webp)$/i.test(input.files?.[0]?.name||''))document.getElementById('removeAttachment').click();
  for(const [key,name] of [['text','Text'],['vision','Vision'],['documents','Documents (app)'],['tools','Tools']]){
   const badge=document.createElement('span'),value=state(data?.capabilities?.[key]?.state);badge.dataset.state=value;badge.textContent=`${name}: ${value}`;
   badge.title=key==='documents'?'Application document-to-text processing; not native vision':key==='tools'?'Model declaration only. Existing tool permissions and behavior remain unchanged.':'Provider-declared metadata; not an inference test.';root.appendChild(badge);
  }
  const image=document.createElement('button');image.type='button';image.textContent=imageAllowed?(data?.automaticImageInput?'Image (automatic vision)':'Image'):'Image unavailable';image.disabled=!imageAllowed;
  image.title=imageAllowed?'Use the existing attachment picker':'Image input unavailable: vision must be verified and the configured adapter must support images.';
  image.addEventListener('click',()=>{if(imageAllowed)input.click();});root.appendChild(image);
  const note=document.createElement('small');note.textContent=data?.checkedAt?(data.freshness==='stale'?'Metadata stale; refreshing. Last checked ':'Metadata checked ')+new Date(data.checkedAt).toLocaleString():'Metadata unavailable or not checked. Automatic refresh will retry.';root.appendChild(note);
 }
 render(null);
 return {imageAllowed:()=>imageAllowed,imageMaxBytes:()=>imageMax,async update(selection,refresh=false){
  const ticket=++sequence;controller?.abort();clearTimer(timer);if(!refresh){last=null;render(null);}else render(last?{...last,freshness:'stale',imageInputAvailable:false}:null);if(!selection)return;
  controller=new AbortController();const requestController=controller;const deadline=setTimer(()=>requestController.abort(),7000);
  try{const response=await fetch('/api/ai/capabilities?'+new URLSearchParams(selection),{credentials:'same-origin',cache:'no-store',signal:controller.signal});if(!response.ok)throw Error();const data=await response.json();
   if(ticket!==sequence)return;if(data.providerId!==selection.providerId||data.model!==selection.model)throw Error();
   const age=Date.now()-Date.parse(data.checkedAt);
   const fresh=data.freshness!=='stale'&&Number.isFinite(age)&&age>=0&&age<300000;
   last=data;render(fresh?data:{...data,freshness:'stale',imageInputAvailable:false});
   timer=setTimer(()=>{if(ticket===sequence)void this.update(selection,true);},fresh?300000-age:30000);
  }catch{if(ticket===sequence){render(last?{...last,freshness:'stale',imageInputAvailable:false}:null);timer=setTimer(()=>{if(ticket===sequence)void this.update(selection,true);},30000);}}finally{clearTimer(deadline);}
 }};
}
if(typeof module!=='undefined')module.exports={createChatCapabilities};
if(typeof document!=='undefined')
(() => {
 const select=document.getElementById('chatModelSelect'), status=document.getElementById('chatModelStatus');
 let sequence=0, models=[],defaultSelection=null;
 const capabilities=createChatCapabilities({document,fetch});
 globalThis.chatCapabilities=capabilities;
 const updateCapabilities=()=>void capabilities.update(globalThis.chatModelSelector.capture()||defaultSelection);
 const encode=s=>s?JSON.stringify({providerId:s.providerId,model:s.model}):'';
 globalThis.chatModelSelector={
  capture(){return select.value?JSON.parse(select.value):null;},
  runtime(){const s=this.capture();const m=models.find(m=>m.providerId===s?.providerId&&m.model===s?.model);return m?{connectionId:m.providerId,modelName:m.model,contextLimit:m.contextLimit,capabilities:m.capabilities}:null;},
  reset(){sequence++;models=[];defaultSelection=null;void capabilities.update(null);select.replaceChildren(new Option('Application default',''));select.disabled=true;},
  async load(saved,isCurrent=()=>true){
   const ticket=++sequence;select.disabled=true;void capabilities.update(null);
   try{
    const r=await fetch('/api/ai/models',{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();
    if(ticket!==sequence||!isCurrent())return;
    models=data.models;const defaultModel=models.find(m=>m.providerId===data.default?.providerId&&m.model===data.default?.model);select.replaceChildren(new Option(defaultModel?'Default: '+defaultModel.providerName+' / '+defaultModel.model:'Application default',''));const groups=new Map();
    for(const m of data.models){let group=groups.get(m.providerId);if(!group){group=document.createElement('optgroup');group.label=m.providerName;groups.set(m.providerId,group);select.appendChild(group);}group.appendChild(new Option(m.name+' — '+m.model,encode(m)));}
    const chosen=encode(saved);
    if(chosen&&!Array.from(select.options).some(o=>o.value===chosen)){select.appendChild(new Option('Unavailable saved model — choose another',chosen));status.textContent='Saved model unavailable. Choose another model before sending.';}
    else status.textContent='Switching models keeps this conversation and its history.';
    select.value=chosen;select.disabled=false;defaultSelection=data.default;updateCapabilities();
   }catch{if(ticket===sequence&&isCurrent()){select.replaceChildren(new Option('Model list unavailable',encode(saved)));select.value=encode(saved);status.textContent='Model list unavailable. Reload to try again.';}}
  }
 };
 select.addEventListener('change',()=>{updateCapabilities();status.textContent='Selected: '+select.selectedOptions[0].textContent+'. Existing history is retained.';saveUserSettings();});
})();
