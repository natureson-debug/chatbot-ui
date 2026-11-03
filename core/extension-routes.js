'use strict';
async function handle(req,res,{user,revalidate}){
 const url=req.url;
 if(!url.startsWith('/api/attachments')&&!url.startsWith('/api/admin/extensions')&&url!=='/api/extensions')return false;
 const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 if(!user){reply(401,{error:'Authentication required'});return true;}
 const admin=url.startsWith('/api/admin/');if(admin&&user.is_admin!==1){reply(403,{error:'Administrator required'});return true;}
 try{
 const extensions=require('./extensions'),attachments=require('./attachments');
 if(req.method==='GET'){
  if(url==='/api/extensions'){const c=await extensions.read();reply(200,{skills:c.skills.filter(s=>s.users.includes('*')||s.users.includes(user.id)).map(s=>({id:s.id,name:s.name})),toolsAvailable:!!c.search?.enabled||c.mcp.some(s=>s.tools.some(t=>t.enabled))});return true;}
  if(url==='/api/admin/extensions'){reply(200,await extensions.read());return true;}
  const match=/^\/api\/attachments\/([a-f0-9-]{36})$/.exec(url);if(!match){reply(404,{error:'Not found'});return true;}
  const a=await attachments.get(user.id,match[1]);if(!revalidate()){reply(401,{error:'Session expired'});return true;}
  const bytes=Buffer.from(a.base64,'base64');res.writeHead(200,{'Content-Type':a.mime,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(a.name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});res.end(bytes);return true;
 }
 if(!require('./restart-request').validRestartRequest({...req,headers:{...req.headers,'x-chatbot-action':req.headers['x-chatbot-action']==='extensions'?'restart-ai':null}})){reply(403,{error:'Same-origin request required'});return true;}
 let body='';for await(const b of req){body+=b;if(body.length>(url==='/api/attachments'?12*1024*1024:512*1024))throw Error();}
 if(!revalidate()){reply(401,{error:'Session expired'});return true;}
 if(req.method==='POST'&&url==='/api/attachments'){const a=await attachments.save(user.id,JSON.parse(body));reply(201,a);return true;}
 if(req.method==='DELETE'&&/^\/api\/attachments\/[a-f0-9-]{36}$/.test(url)){await attachments.remove(user.id,url.split('/')[3]);reply(200,{deleted:true});return true;}
 if(admin&&req.method==='POST'&&url==='/api/admin/extensions'){reply(200,await extensions.save(JSON.parse(body)));return true;}
 const m=/^\/api\/admin\/extensions\/mcp\/([a-z0-9-]+)\/check$/.exec(url);
 if(admin&&req.method==='POST'&&m){const config=await extensions.read(),server=config.mcp.find(s=>s.id===m[1]);if(!server)throw Error();const tools=await require('./mcp-client').discover(server);if(!revalidate()){reply(401,{error:'Session expired'});return true;}reply(200,{state:'connected',tools});return true;}
 reply(405,{error:'Method not allowed'});
 }catch{reply(400,{error:'Extension operation unavailable, unauthorized or invalid. Unsupported documents and extraction limits are rejected.'});}
 return true;
}
module.exports={handle};
