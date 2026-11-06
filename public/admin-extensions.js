'use strict';
(()=>{
 const editor=document.getElementById('extensionConfig'),status=document.getElementById('extensionStatus');
 let pending=false,credentialPending=false;
 function showResult(severity,title,message,{preserveStatus=false}={}){
  try{
   if(globalThis.ChatbotNotifications){
    globalThis.ChatbotNotifications.show({severity,title,message});
    if(!preserveStatus)status.textContent='';
    return;
   }
  }catch{console.warn('Could not display extension notification.');}
  status.textContent=preserveStatus?status.textContent+' '+message:message;
 }
 function parseEditor(){const value=JSON.parse(editor.value);if(value&&value.mcpServers){return{version:1,revision:0,skills:[],search:null,mcp:Object.entries(value.mcpServers).map(([id,server])=>({id,transport:'stdio',command:server.command,args:server.args||[],credentialRef:null,tools:[]}))};}return value;}
 async function run(kind,{initial=false}={}){
  if(pending)return;
  pending=true;
  try{
   let url='/api/admin/extensions',options={cache:'no-store'};
   if(kind!=='load'){
    if(kind==='check'){
     const id=document.getElementById('mcpCheckId').value;
     if(!/^[a-z][a-z0-9-]{0,30}$/.test(id))throw Error('Invalid MCP ID');
     url+='/mcp/'+id+'/check';
    }
    options={method:'POST',headers:{'Content-Type':'application/json','X-Chatbot-Action':'extensions'},body:kind==='save'?JSON.stringify(parseEditor()):'{}'};
   }
   const r=await fetch(url,options),data=await r.json();
   if(!r.ok)throw Error('Extension request failed');
   if(kind!=='check')editor.value=JSON.stringify(data,null,2);
   if(kind==='check'){
    status.textContent='Discovered tools (not automatically enabled): '+data.tools.map(t=>t.name).join(', ');
    showResult('success','MCP check complete','MCP server connected. Review the discovered tools.',{preserveStatus:true});
   }else if(!initial){
    showResult('success',kind==='save'?'Extensions saved':'Extensions reloaded',kind==='save'?'Extension configuration saved. Tool permissions remain independent of skills.':'Extension configuration reloaded.');
   }else status.textContent='';
  }catch{
   const message='Operation unavailable. Verify configuration, revision and server-side credentials. No automatic retry.';
   if(initial)status.textContent=message;
   else showResult('error','Extension operation failed',message);
  }finally{pending=false;}
 }
 const credentialInput=document.getElementById('braveSearchCredential'),credentialStatus=document.getElementById('braveCredentialStatus'),clearCredential=document.getElementById('clearBraveCredential');
 async function refreshBraveCredential(){try{const r=await fetch('/api/admin/extensions/brave-credential',{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();clearCredential.disabled=!data.configured;credentialStatus.textContent=data.configured?'Protected Brave key is stored.':'No protected Brave key is stored.';}catch{clearCredential.disabled=true;credentialStatus.textContent='Credential status unavailable.';}}
 async function changeBraveCredential(action){
  if(credentialPending)return;
  const credential=credentialInput.value;
  if(action==='save'&&!credential){credentialStatus.textContent='Enter a key before saving.';return;}
  credentialPending=true;clearCredential.disabled=true;
  let outcome;
  try{
   const r=await fetch('/api/admin/extensions/brave-credential',{method:'POST',headers:{'Content-Type':'application/json','X-Chatbot-Action':'extensions'},body:JSON.stringify(action==='save'?{action,credential}:{action}),cache:'no-store'});
   const data=await r.json();if(!r.ok||data.configured!==(action==='save'))throw Error();
   credentialInput.value='';
   outcome={severity:'success',title:'Brave credential updated',message:action==='save'?'Protected Brave key saved.':'Protected Brave key cleared.'};
  }catch{
   outcome={severity:'error',title:'Brave credential operation failed',message:'Credential operation unavailable. No key was returned.'};
  }finally{
   credentialPending=false;await refreshBraveCredential();
  }
  showResult(outcome.severity,outcome.title,outcome.message);
 }
 document.getElementById('saveExtensions').addEventListener('click',()=>run('save'));
 document.getElementById('reloadExtensions').addEventListener('click',()=>run('load'));
 document.getElementById('checkMcp').addEventListener('click',()=>run('check'));
 void run('load',{initial:true});
 document.getElementById('saveBraveCredential').addEventListener('click',()=>changeBraveCredential('save'));
 clearCredential.addEventListener('click',()=>changeBraveCredential('clear'));
 void refreshBraveCredential();
})();
