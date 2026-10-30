'use strict';
function createAdminMonitor({document,fetch,setTimer=setTimeout,clearTimer=clearTimeout}) {
    const status=document.getElementById('monitorStatus'),cards=document.getElementById('monitorCards');
    const rows=document.getElementById('monitorHistory'),toggle=document.getElementById('monitorToggle');
    let paused=false,stopped=false,inFlight=false,timer=null,controller=null,epoch=0,last=null,history=[];
    const format=(n,unit='')=>typeof n==='number'&&Number.isFinite(n)?`${n.toLocaleString(undefined,{maximumFractionDigits:1})}${unit}`:'Unavailable';
    function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
    function card(title,values){const node=element('article',undefined,'monitor-card');node.append(element('h3',title));for(const [label,value] of values){const line=element('p');line.append(element('span',label+': '),element('strong',value));node.append(line);}cards.append(node);}
    function render(sample){
        cards.replaceChildren();
        const b=sample.backend;
        card('llama.cpp', [['Status',b.state.replaceAll('_',' ')],['Reported model',b.model||'Unavailable'],['Context per slot',format(b.contextPerSlot)],['Parallel slots',format(b.parallelSlots)]]);
        card('Inference metrics', [['Source',b.metricsState==='available'?'llama.cpp /metrics':b.metricsState.replaceAll('_',' ')],['Generation',format(b.metrics.generatedTokensPerSecond,' tokens/s')],['Prompt processing',format(b.metrics.promptTokensPerSecond,' tokens/s')],['Active / queued',format(b.metrics.requestsProcessing)+' / '+format(b.metrics.requestsDeferred)],['Generated tokens (process total)',format(b.metrics.generatedTokensTotal)]]);
        if(sample.gpu.devices.length===0)card('NVIDIA GPU',[['Status','Unavailable']]);
        for(const gpu of sample.gpu.devices){card(gpu.name||'NVIDIA GPU',[
            ['GPU UUID',gpu.uuid],['Driver',gpu.driver||'Unavailable'],['Utilization',format(gpu.utilizationPercent,'%')],
            ['VRAM used / total',format(gpu.memoryUsedMiB,' MiB')+' / '+format(gpu.memoryTotalMiB,' MiB')],
            ['Temperature',format(gpu.temperatureC,' °C')],['Power / limit',format(gpu.powerW,' W')+' / '+format(gpu.powerLimitW,' W')]
        ]);}
        if(sample.sampledAt!==last){history.push(sample);history=history.slice(-12);last=sample.sampledAt;}
        rows.replaceChildren();
        for(const entry of [...history].reverse()){
            const devices=entry.gpu.devices.length?entry.gpu.devices:[null];
            for(const gpu of devices){const row=element('tr');for(const value of [new Date(entry.sampledAt).toLocaleTimeString(),gpu?.name||'Unavailable',format(gpu?.utilizationPercent,'%'),format(gpu?.memoryUsedMiB,' MiB'),format(gpu?.temperatureC,' °C'),format(entry.backend.metrics.generatedTokensPerSecond,' tokens/s')])row.append(element('td',value));rows.append(row);}
        }
        status.textContent='Last observation: '+new Date(sample.sampledAt).toLocaleTimeString()+'. Read-only; GPU readings include all applications.';
    }
    async function poll(){
        if(paused||stopped||document.hidden||inFlight)return;
        clearTimer(timer);inFlight=true;const generation=epoch;controller=new AbortController();
        const deadline=setTimer(()=>controller?.abort(),8000);
        try{
            const response=await fetch('/api/admin/ai/telemetry',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
            if(generation!==epoch)return;
            if(response.status===401||response.status===403){stopped=true;history=[];last=null;cards.replaceChildren();rows.replaceChildren();status.textContent='Administrator session required. Reload after signing in.';return;}
            if(!response.ok)throw Error('unavailable');
            const sample=await response.json();
            if(generation===epoch&&!document.hidden&&!paused)render(sample);
        }catch{
            if(generation===epoch&&!paused&&!document.hidden)status.textContent='Monitoring unavailable. Displayed readings are historical, not live. Retrying in 5 seconds.';
        }finally{
            clearTimer(deadline);controller=null;inFlight=false;
            if(!paused&&!stopped&&!document.hidden)timer=setTimer(poll,5000);
        }
    }
    function suspend(){epoch++;clearTimer(timer);controller?.abort();}
    toggle.addEventListener('click',()=>{paused=!paused;suspend();toggle.textContent=paused?'Resume monitoring':'Pause monitoring';status.textContent=paused?'Monitoring paused; displayed readings are historical.':'Resuming monitoring...';if(!paused)poll();});
    document.addEventListener('visibilitychange',()=>{suspend();if(!document.hidden)poll();});
    return {poll,dispose(){stopped=true;suspend();history=[];cards.replaceChildren();rows.replaceChildren();}};
}
if(typeof module!=='undefined'&&module.exports)module.exports={createAdminMonitor};
else {
    const monitor=createAdminMonitor({document,fetch:window.fetch.bind(window)});
    monitor.poll();
    window.addEventListener('pagehide',()=>monitor.dispose(),{once:true});
    window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
}
