'use strict';
function createWatchdogMonitor({document,fetch,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}) {
    const host=document.getElementById('tab-monitor');
    if(!host) return {poll:async()=>{},dispose:()=>{}};
    const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
    const panel=el('section');panel.className='monitor-card';panel.setAttribute('aria-label','Watchdog status');
    const status=el('p','Waiting for watchdog status…');status.setAttribute('role','status');
    const values=el('div'),history=el('ol');
    panel.append(el('h3','Watchdog — read-only'),status,values,el('h4','Recent observations'),history);
    host.append(panel);
    let stopped=false,busy=false,timer=null,controller=null,epoch=0;
    const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString():'Unavailable';
    function render(data) {
        if(!data || !Number.isFinite(Date.parse(data.sampledAt))) throw Error('Malformed');
        values.replaceChildren();history.replaceChildren();
        const stale=now()-Date.parse(data.sampledAt)>30000 || Date.parse(data.sampledAt)>now()+5000;
        status.textContent=(stale?'Stale snapshot. ':data.availability==='observed'?'Observed. ':'Status unavailable or unsupported. ')+date(data.sampledAt);
        const task=data.task,b=data.backend,log=data.log;
        for(const [label,value] of [
            ['Task',task?`${task.state} (${task.enabled?'enabled':'disabled'})`:'Unavailable'],
            ['Last run',date(task?.lastRun)],['Last result',Number.isSafeInteger(task?.lastResult)?String(task.lastResult):'Unavailable'],
            ['Next run',date(task?.nextRun)],['Backend PID',b?.pid??'Unavailable'],
            ['Backend ownership',b?(b.verified?'Verified observation':'Unverified'):'Unavailable'],
            ['Saved configuration',b?(b.configurationMatched?'Matched':'Not verified/mismatched'):'Unavailable'],
            ['Recovery marker',data.marker||'unavailable'],['Log last modified',date(log?.updatedAt)]
        ]) values.append(el('p',`${label}: ${value}`));
        if(!log) history.append(el('li','Log unavailable.'));
        else {
            history.append(el('li',`${log.stale?'Stale log. ':''}${log.malformed?'Some records could not be read. ':''}Records have no individual timestamps; file modification time is not an event timestamp.`));
            for(const o of (Array.isArray(log.observations)?log.observations:[]).slice(-12)) history.append(el('li',`${o.state}: ${o.reason}; recovery attempted: ${o.recoveryAttempted?'yes':'no'}`));
            if(!log.observations?.length) history.append(el('li','No recognized observations.'));
        }
    }
    function schedule(){clearTimer(timer);if(!stopped&&!document.hidden)timer=setTimer(poll,15000);}
    async function poll(){
        if(stopped||busy||document.hidden)return;
        busy=true;const version=epoch;controller=new AbortController();
        const deadline=setTimer(()=>controller?.abort(),10000);
        try {
            const r=await fetch('/api/admin/watchdog/status',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
            if(version!==epoch)return;
            if(r.status===401||r.status===403){stopped=true;values.replaceChildren();history.replaceChildren();status.textContent='Administrator session required.';return;}
            if(!r.ok)throw Error('Unavailable');
            const data=await r.json();if(version===epoch&&!document.hidden)render(data);
        } catch {if(version===epoch){values.replaceChildren();history.replaceChildren();status.textContent='Watchdog status unavailable; no current readings.';}}
        finally {clearTimer(deadline);busy=false;controller=null;schedule();}
    }
    function visibility(){epoch++;clearTimer(timer);controller?.abort();if(document.hidden)status.textContent='Polling paused while tab is hidden.';else if(!busy)void poll();}
    document.addEventListener('visibilitychange',visibility);
    return {poll,dispose(){stopped=true;epoch++;clearTimer(timer);controller?.abort();document.removeEventListener('visibilitychange',visibility);}};
}
if(typeof module!=='undefined')module.exports={createWatchdogMonitor};
if(typeof window!=='undefined'){
    const monitor=createWatchdogMonitor({document,fetch:window.fetch.bind(window)});
    void monitor.poll();window.addEventListener('pagehide',()=>monitor.dispose(),{once:true});
}
