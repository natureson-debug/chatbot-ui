'use strict';
function createWatchdogStatusRoute({token,authenticate,sample}) {
    return async (req,res) => {
        if(req.url.split('?')[0]!=='/api/admin/watchdog/status') return false;
        const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
        const original=token(req);
        const admin=authenticate(original);
        if(!admin || admin.is_admin!==1){reply(admin?403:401,{error:'Administrator access required'});return true;}
        if(req.method!=='GET'){reply(405,{error:'Read-only endpoint'});return true;}
        const data=await sample();
        const current=authenticate(original);
        if(!current || current.id!==admin.id || current.is_admin!==1){reply(401,{error:'Session no longer authorized'});return true;}
        if(!res.destroyed && !res.writableEnded) reply(200,data);
        return true;
    };
}
module.exports={createWatchdogStatusRoute};
