'use strict';
(()=>{
 const editor=document.getElementById('extensionConfig'),status=document.getElementById('extensionStatus');let pending=false,credentialPending=false;
 function parseEditor(){const value=JSON.parse(editor.value);if(value&&value.mcpServers){return{version:1,revision:0,skills:[],search:null,mcp:Object.entries(value.mcpServers).map(([id,server])=>({id,transport:'stdio',command:server.command,args:server.args||[],credentialRef:null,tools:[]}))};}return value;}
 async function run(kind){if(pending)return;pending=true;try{let url='/api/admin/extensions',options={cache:'no-store'};
  if(kind!=='load'){if(kind==='check'){const id=document.getElementById('mcpCheckId').value;if(!/^[a-z][a-z0-9-]{0,30}$/.test(id))throw Error();url+='/mcp/'+id+'/check';}options={method:'POST',headers:{'Content-Type':'application/json','X-Chatbot-Action':'extensions'},body:kind==='save'?JSON.stringify(parseEditor()):'{}'};}
  const r=await fetch(url,options),data=await r.json();if(!r.ok)throw Error();if(kind!=='check')editor.value=JSON.stringify(data,null,2);
  status.textContent=kind==='check'?'Connected. Discovered tools (not automatically enabled): '+data.tools.map(t=>t.name).join(', '):'Configuration loaded/saved. Tool permissions are independent of skill instructions.';
 }catch{status.textContent='Operation unavailable. Verify configuration, revision and server-side credentials. No automatic retry.';}finally{pending=false;}}
 const credentialInput=document.getElementById('braveSearchCredential'),credentialStatus=document.getElementById('braveCredentialStatus'),clearCredential=document.getElementById('clearBraveCredential');
 async function refreshBraveCredential(){try{const r=await fetch('/api/admin/extensions/brave-credential',{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();clearCredential.disabled=!data.configured;credentialStatus.textContent=data.configured?'Protected Brave key is stored.':'No protected Brave key is stored.';}catch{clearCredential.disabled=true;credentialStatus.textContent='Credential status unavailable.';}}
 async function changeBraveCredential(action){if(credentialPending)return;const credential=credentialInput.value;if(action==='save'&&!credential){credentialStatus.textContent='Enter a key before saving.';return;}credentialPending=true;clearCredential.disabled=true;
  try{const r=await fetch('/api/admin/extensions/brave-credential',{method:'POST',headers:{'Content-Type':'application/json','X-Chatbot-Action':'extensions'},body:JSON.stringify(action==='save'?{action,credential}:{action}),cache:'no-store'});const data=await r.json();if(!r.ok||data.configured!==(action==='save'))throw Error();credentialInput.value='';credentialStatus.textContent=action==='save'?'Protected Brave key saved.':'Protected Brave key cleared.';}
  catch{credentialStatus.textContent='Credential operation unavailable. No key was returned.';}
  finally{credentialPending=false;await refreshBraveCredential();}
 }
 document.getElementById('saveExtensions').addEventListener('click',()=>run('save'));document.getElementById('reloadExtensions').addEventListener('click',()=>run('load'));document.getElementById('checkMcp').addEventListener('click',()=>run('check'));run('load');
 document.getElementById('saveBraveCredential').addEventListener('click',()=>changeBraveCredential('save'));
 clearCredential.addEventListener('click',()=>changeBraveCredential('clear'));
 refreshBraveCredential();
})();
