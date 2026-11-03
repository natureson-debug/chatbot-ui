'use strict';
(()=>{
 const editor=document.getElementById('extensionConfig'),status=document.getElementById('extensionStatus');let pending=false;
 function parseEditor(){const value=JSON.parse(editor.value);if(value&&value.mcpServers){return{version:1,revision:0,skills:[],search:null,mcp:Object.entries(value.mcpServers).map(([id,server])=>({id,transport:'stdio',command:server.command,args:server.args||[],credentialRef:null,tools:[]}))};}return value;}
 async function run(kind){if(pending)return;pending=true;try{let url='/api/admin/extensions',options={cache:'no-store'};
  if(kind!=='load'){if(kind==='check'){const id=document.getElementById('mcpCheckId').value;if(!/^[a-z][a-z0-9-]{0,30}$/.test(id))throw Error();url+='/mcp/'+id+'/check';}options={method:'POST',headers:{'Content-Type':'application/json','X-Chatbot-Action':'extensions'},body:kind==='save'?JSON.stringify(parseEditor()):'{}'};}
  const r=await fetch(url,options),data=await r.json();if(!r.ok)throw Error();if(kind!=='check')editor.value=JSON.stringify(data,null,2);
  status.textContent=kind==='check'?'Connected. Discovered tools (not automatically enabled): '+data.tools.map(t=>t.name).join(', '):'Configuration loaded/saved. Tool permissions are independent of skill instructions.';
 }catch{status.textContent='Operation unavailable. Verify configuration, revision and server-side credentials. No automatic retry.';}finally{pending=false;}}
 document.getElementById('saveExtensions').addEventListener('click',()=>run('save'));document.getElementById('reloadExtensions').addEventListener('click',()=>run('load'));document.getElementById('checkMcp').addEventListener('click',()=>run('check'));run('load');
})();
