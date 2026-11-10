'use strict';
function createAdminMonitor({document,fetch,setTimer=setTimeout,clearTimer=clearTimeout}) {
    const status=document.getElementById('monitorStatus'),cards=document.getElementById('monitorCards');
    const chartsContainer=document.getElementById('monitorCharts'),toggle=document.getElementById('monitorToggle');
    const timeRangeSelect=document.getElementById('monitorTimeRange'),refreshRate=document.getElementById('monitorRefreshRate');
    let paused=false,stopped=false,inFlight=false,timer=null,controller=null,epoch=0,lastSampleTime=null;
    let currentTimeRange='realtime',historyData=[],gpuDevices=[];
    let realtimeData={},realtimeTimer=null;
    const realtimeMaxSamples=60,realtimeBuffers={};
    
    const format=(n,unit='')=>typeof n==='number'&&Number.isFinite(n)?`${n.toLocaleString(undefined,{maximumFractionDigits:1})}${unit}`:'Unavailable';
    const refreshMs=()=>{
        if(currentTimeRange==='realtime')return 1000; // Real-time: 1Hz
        const seconds=Number(refreshRate?.value);
        return [1,5,10].includes(seconds)?seconds*1000:5000;
    };
    
    if(refreshRate){
        refreshRate.disabled=true;
        if(typeof window!=='undefined'&&typeof window.syncTerminalSelect==='function')window.syncTerminalSelect(refreshRate);
    }
    
    if(timeRangeSelect){
        timeRangeSelect.addEventListener('change',(e)=>{
            currentTimeRange=e.target.value;
            if(currentTimeRange==='realtime'){
                realtimeBuffers={};
                startRealtimePolling();
            }else{
                stopRealtimePolling();
                loadAndRenderCharts();
            }
        });
    }
    
    function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
    function card(title,values){const node=element('article',undefined,'monitor-card');node.append(element('h3',title));for(const [label,value] of values){const line=element('p');line.append(element('span',label+': '),element('strong',value));node.append(line);}cards.append(node);}
    
    function renderLiveCards(sample){
        cards.replaceChildren();
        const b=sample.backend;
        card('llama.cpp', [['Status',b.state.replaceAll('_',' ')],['Reported model',b.model||'Unavailable'],['Context per slot',format(b.contextPerSlot)],['Parallel slots',format(b.parallelSlots)]]);
        card('Inference metrics', [
            ['Metrics endpoint',b.metricsState==='available'?'llama.cpp /metrics':b.metricsState.replaceAll('_',' ')],
            ['Generation',format(b.metrics.generatedTokensPerSecond,' tokens/s')],
            ['Prompt processing',format(b.metrics.promptTokensPerSecond,' tokens/s')],
            ['Generated tokens (process total)',format(b.metrics.generatedTokensTotal)],
            ['Slot observation',b.slotState==='available'?'available':(b.slotState||'unavailable').replaceAll('_',' ')],
            ['Active requests',format(b.slotState==='available'?b.activeRequests:b.metrics.requestsProcessing)],
            ['Queued requests',format(b.metrics.requestsDeferred)],
            ['Context capacity per slot',format(b.contextPerSlot)],
            ['Context currently used',format(b.contextUsedTokens)],
            ['Slot prompt tokens reported',format(b.slotPromptTokens)]
        ]);
        if(sample.gpu.devices.length===0)card('NVIDIA GPU',[['Status','Unavailable']]);
        for(const gpu of sample.gpu.devices){card(gpu.name||'NVIDIA GPU',[
            ['GPU UUID',gpu.uuid],['Driver',gpu.driver||'Unavailable'],['Utilization',format(gpu.utilizationPercent,'%')],
            ['VRAM used / total',format(gpu.memoryUsedMiB,' MiB')+' / '+format(gpu.memoryTotalMiB,' MiB')],
            ['Temperature',format(gpu.temperatureC,' °C')],['Power / limit',format(gpu.powerW,' W')+' / '+format(gpu.powerLimitW,' W')]
        ]);}
        status.textContent='Last observation: '+new Date(sample.sampledAt).toLocaleTimeString()+'. Read-only; GPU readings include all applications.';
    }
    
    function renderChart(containerId,title,dataPoints,yLabel,yMax,formatFn){
        const container=document.getElementById(containerId);if(!container)return;
        container.replaceChildren();
        const chart=element('div',undefined,'monitor-chart');
        const titleEl=element('h3',title);
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('viewBox','0 0 800 300');svg.setAttribute('preserveAspectRatio','xMidYMid meet');
        svg.setAttribute('class','chart-svg');
        
        if(dataPoints.length===0){
            const text=document.createElementNS('http://www.w3.org/2000/svg','text');
            text.setAttribute('x','400');text.setAttribute('y','150');text.setAttribute('text-anchor','middle');
            text.setAttribute('fill','#999');text.textContent='No data';
            svg.appendChild(text);
            chart.append(titleEl,svg);container.append(chart);return;
        }
        
        const padding={top:20,right:30,bottom:40,left:50};
        const w=800-padding.left-padding.right;
        const h=300-padding.top-padding.bottom;
        const points=dataPoints.filter(p=>p.value!==null);
        const xStep=points.length>1?w/(points.length-1):0;
        
        let group=document.createElementNS('http://www.w3.org/2000/svg','g');
        group.setAttribute('transform',`translate(${padding.left},${padding.top})`);
        
        // Axes
        const xAxis=document.createElementNS('http://www.w3.org/2000/svg','line');
        xAxis.setAttribute('x1','0');xAxis.setAttribute('y1',h);xAxis.setAttribute('x2',w);xAxis.setAttribute('y2',h);
        xAxis.setAttribute('stroke','#ccc');xAxis.setAttribute('stroke-width','1');group.appendChild(xAxis);
        
        const yAxis=document.createElementNS('http://www.w3.org/2000/svg','line');
        yAxis.setAttribute('x1','0');yAxis.setAttribute('y1','0');yAxis.setAttribute('x2','0');yAxis.setAttribute('y2',h);
        yAxis.setAttribute('stroke','#ccc');yAxis.setAttribute('stroke-width','1');group.appendChild(yAxis);
        
        // Y-axis labels
        for(let i=0;i<=5;i++){
            const val=Math.round((yMax/5)*i);
            const y=h-((i/5)*h);
            const text=document.createElementNS('http://www.w3.org/2000/svg','text');
            text.setAttribute('x','-10');text.setAttribute('y',y);text.setAttribute('text-anchor','end');
            text.setAttribute('dominant-baseline','middle');text.setAttribute('font-size','12');
            text.setAttribute('fill','#666');text.textContent=val;
            group.appendChild(text);
        }
        
        // Grid lines
        for(let i=1;i<5;i++){
            const y=h-((i/5)*h);
            const line=document.createElementNS('http://www.w3.org/2000/svg','line');
            line.setAttribute('x1','0');line.setAttribute('y1',y);line.setAttribute('x2',w);line.setAttribute('y2',y);
            line.setAttribute('stroke','#eee');line.setAttribute('stroke-width','1');group.appendChild(line);
        }
        
        // Path
        let pathData='';
        for(let i=0;i<points.length;i++){
            const p=points[i];
            const x=i*xStep;
            const y=h-((p.value/yMax)*h);
            pathData+=`${i===0?'M':'L'} ${x} ${y} `;
        }
        const path=document.createElementNS('http://www.w3.org/2000/svg','path');
        path.setAttribute('d',pathData);path.setAttribute('fill','none');
        path.setAttribute('stroke','#0066cc');path.setAttribute('stroke-width','2');group.appendChild(path);
        
        // Data points
        for(let i=0;i<points.length;i++){
            const p=points[i];
            const x=i*xStep;
            const y=h-((p.value/yMax)*h);
            const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');
            circle.setAttribute('cx',x);circle.setAttribute('cy',y);circle.setAttribute('r','3');
            circle.setAttribute('fill','#0066cc');circle.addEventListener('mouseover',()=>{
                const tooltip=document.createElement('div');tooltip.className='chart-tooltip';
                tooltip.textContent=formatFn(p.value);tooltip.style.left=(padding.left+x)+'px';
                tooltip.style.top=(padding.top+y-30)+'px';svg.parentElement.parentElement.appendChild(tooltip);
                setTimeout(()=>tooltip.remove(),2000);
            });group.appendChild(circle);
        }
        
        // Y-axis label
        const yLabel_=document.createElementNS('http://www.w3.org/2000/svg','text');
        yLabel_.setAttribute('transform','rotate(-90)');yLabel_.setAttribute('y',-padding.left+15);
        yLabel_.setAttribute('x',-(h/2));yLabel_.setAttribute('text-anchor','middle');yLabel_.setAttribute('font-size','12');
        yLabel_.setAttribute('fill','#666');yLabel_.textContent=yLabel;group.appendChild(yLabel_);
        
        // X-axis time labels
        const timeLabels=[points[0],points[Math.floor(points.length/4)],points[Math.floor(points.length/2)],
                          points[Math.floor(3*points.length/4)],points[points.length-1]];
        timeLabels.forEach((p,idx)=>{
            if(!p)return;
            const x=(timeLabels.indexOf(p)/(timeLabels.length-1||1))*w;
            const text=document.createElementNS('http://www.w3.org/2000/svg','text');
            text.setAttribute('x',x);text.setAttribute('y',h+25);text.setAttribute('text-anchor','middle');
            text.setAttribute('font-size','11');text.setAttribute('fill','#666');
            text.textContent=new Date(p.time).toLocaleTimeString();group.appendChild(text);
        });
        
        svg.appendChild(group);
        chart.append(titleEl,svg);container.append(chart);
    }
    
    function addRealtimeSample(sample){
        if(!sample||!sample.gpu||!sample.gpu.devices)return;
        const now=Date.now();
        for(const gpu of sample.gpu.devices){
            const key=`gpu_${gpu.uuid||gpu.name||'unknown'}`;
            if(!realtimeBuffers[key]){
                realtimeBuffers[key]={
                    name:gpu.name||`GPU ${Object.keys(realtimeBuffers).length}`,
                    uuid:gpu.uuid,
                    util:[],temp:[],power:[],vram:[]
                };
            }
            const buf=realtimeBuffers[key];
            buf.util.push({t:now,v:gpu.utilizationPercent});
            buf.temp.push({t:now,v:gpu.temperatureC});
            buf.power.push({t:now,v:gpu.powerW});
            buf.vram.push({t:now,v:gpu.memoryUsedMiB});
            [buf.util,buf.temp,buf.power,buf.vram].forEach(arr=>{if(arr.length>realtimeMaxSamples)arr.shift();});
        }
    }
    
    function renderRealtimeCharts(){
        if(!chartsContainer||Object.keys(realtimeBuffers).length===0){
            if(chartsContainer)chartsContainer.innerHTML='<p style="text-align:center;color:#999;">Waiting for real-time data...</p>';
            return;
        }
        chartsContainer.replaceChildren();
        for(const [key,buf] of Object.entries(realtimeBuffers)){
            const gpuSection=document.createElement('section');gpuSection.className='monitor-gpu-section';
            const header=document.createElement('h2');header.textContent=buf.name;gpuSection.appendChild(header);
            
            const containerDivs=[];
            if(buf.util.length>0){
                const div=document.createElement('div');div.id=`rt-util-${key}`;div.className='monitor-chart-container';
                gpuSection.appendChild(div);
                containerDivs.push({id:div.id,title:`${buf.name} Utilization`,data:buf.util.map(p=>({time:new Date(p.t).toLocaleTimeString(),value:p.v})),yMax:100,fmt:n=>`${n}%`,yLabel:'%'});
            }
            if(buf.temp.length>0){
                const div=document.createElement('div');div.id=`rt-temp-${key}`;div.className='monitor-chart-container';
                gpuSection.appendChild(div);
                const maxTemp=Math.max(...buf.temp.map(p=>p.v||0),100);
                containerDivs.push({id:div.id,title:`${buf.name} Temperature`,data:buf.temp.map(p=>({time:new Date(p.t).toLocaleTimeString(),value:p.v})),yMax:maxTemp,fmt:n=>`${n}°C`,yLabel:'°C'});
            }
            if(buf.power.length>0){
                const div=document.createElement('div');div.id=`rt-power-${key}`;div.className='monitor-chart-container';
                gpuSection.appendChild(div);
                const maxPower=Math.max(...buf.power.map(p=>p.v||0),500);
                containerDivs.push({id:div.id,title:`${buf.name} Power`,data:buf.power.map(p=>({time:new Date(p.t).toLocaleTimeString(),value:p.v})),yMax:maxPower,fmt:n=>`${n}W`,yLabel:'W'});
            }
            if(buf.vram.length>0){
                const div=document.createElement('div');div.id=`rt-vram-${key}`;div.className='monitor-chart-container';
                gpuSection.appendChild(div);
                const maxVram=Math.max(...buf.vram.map(p=>p.v||0),24576);
                containerDivs.push({id:div.id,title:`${buf.name} VRAM`,data:buf.vram.map(p=>({time:new Date(p.t).toLocaleTimeString(),value:p.v})),yMax:maxVram,fmt:n=>`${(n/1024).toFixed(1)}GiB`,yLabel:'GiB'});
            }
            chartsContainer.appendChild(gpuSection);
            containerDivs.forEach(c=>renderChart(c.id,c.title,c.data,c.yLabel,c.yMax,c.fmt));
        }
    }
    
    async function pollRealtime(){
        if(paused||stopped||document.hidden||currentTimeRange!=='realtime')return;
        clearTimer(realtimeTimer);
        try{
            const response=await fetch('/api/admin/ai/telemetry/realtime',{credentials:'same-origin',cache:'no-store'});
            if(response.status===401||response.status===403){stopped=true;suspend();status.textContent='Administrator session required. Reload after signing in.';return;}
            if(!response.ok)throw Error('unavailable');
            const data=await response.json();
            if(data.sample){
                renderLiveCards(data.sample);
                addRealtimeSample(data.sample);
                renderRealtimeCharts();
                status.textContent=`Real-time monitoring (${Object.keys(realtimeBuffers).length} GPU${Object.keys(realtimeBuffers).length!==1?'s':''}, 60-second window). Source: ${data.source}`;
            }
        }catch(e){
            console.error('Real-time poll failed:',e);
            if(!document.hidden&&!paused)status.textContent='Real-time data unavailable. Retrying...';
        }finally{
            if(currentTimeRange==='realtime'&&!paused&&!stopped&&!document.hidden){
                realtimeTimer=setTimer(pollRealtime,1000);
            }
        }
    }
    
    function startRealtimePolling(){
        if(currentTimeRange!=='realtime')return;
        clearTimer(realtimeTimer);
        pollRealtime();
    }
    
    function stopRealtimePolling(){
        clearTimer(realtimeTimer);
        realtimeTimer=null;
    }
    
    async function loadAndRenderCharts(){
        if(!chartsContainer)return;
        if(currentTimeRange==='realtime'){
            renderRealtimeCharts();
            return;
        }
        try{
            const response=await fetch(`/api/admin/ai/telemetry/history/${currentTimeRange}`,{credentials:'same-origin',cache:'no-store'});
            if(!response.ok)throw Error('Failed to load history');
            const data=await response.json();
            historyData=data.samples||[];
            
            if(historyData.length===0){
                chartsContainer.innerHTML='<p style="text-align:center;color:#999;">No telemetry data available.</p>';
                return;
            }
            
            // Group by GPU index and extract time series
            const gpuIndices=new Set(historyData.map(s=>s.gpu_index));
            const charts=[];
            
            for(const idx of gpuIndices){
                if(idx===-1)continue; // Skip backend sentinel
                const gpuData=historyData.filter(s=>s.gpu_index===idx);
                const gpuName=gpuData[0]?.gpu_name||`GPU ${idx}`;
                
                charts.push({name:gpuName,data:[
                    {id:`util-${idx}`,title:`${gpuName} Utilization`,points:gpuData.map(s=>({time:s.sampled_at,value:s.utilization_percent})),yMax:100,fmt:n=>`${n}%`},
                    {id:`temp-${idx}`,title:`${gpuName} Temperature`,points:gpuData.map(s=>({time:s.sampled_at,value:s.temperature_c})),yMax:100,fmt:n=>`${n}°C`},
                    {id:`power-${idx}`,title:`${gpuName} Power`,points:gpuData.map(s=>({time:s.sampled_at,value:s.power_w})),yMax:gpuData.reduce((max,s)=>Math.max(max,s.power_limit_w||0),500),fmt:n=>`${n}W`},
                    {id:`mem-${idx}`,title:`${gpuName} VRAM Usage`,points:gpuData.map(s=>({time:s.sampled_at,value:s.memory_used_mib})),yMax:gpuData.reduce((max,s)=>Math.max(max,s.memory_total_mib||0),24576),fmt:n=>`${(n/1024).toFixed(1)}GB`}
                ]});
            }
            
            chartsContainer.replaceChildren();
            charts.forEach(gpu=>{
                const gpuSection=document.createElement('section');gpuSection.className='monitor-gpu-section';
                const header=document.createElement('h2');header.textContent=gpu.name;gpuSection.appendChild(header);
                gpu.data.forEach(c=>{
                    const div=document.createElement('div');div.id=c.id;div.className='monitor-chart-container';
                    gpuSection.appendChild(div);
                    renderChart(c.id,c.title,c.points,c.title.split(' ').pop(),c.yMax,c.fmt);
                });
                chartsContainer.appendChild(gpuSection);
            });
        }catch(e){
            console.error('Chart load failed:',e);
            chartsContainer.innerHTML='<p style="text-align:center;color:#c00;">Failed to load charts.</p>';
        }
    }
    
    async function poll(){
        if(currentTimeRange==='realtime'){
            pollRealtime();
            return;
        }
        if(paused||stopped||document.hidden||inFlight)return;
        clearTimer(timer);inFlight=true;const generation=epoch;controller=new AbortController();
        const deadline=setTimer(()=>controller?.abort(),8000);
        try{
            const response=await fetch('/api/admin/ai/telemetry',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
            if(generation!==epoch)return;
            if(response.status===401||response.status===403){stopped=true;chartsContainer.replaceChildren();cards.replaceChildren();status.textContent='Administrator session required. Reload after signing in.';return;}
            if(!response.ok)throw Error('unavailable');
            const sample=await response.json();
            if(generation===epoch&&!document.hidden&&!paused){
                renderLiveCards(sample);
                lastSampleTime=sample.sampledAt;
                if(historyData.length===0)loadAndRenderCharts();
            }
        }catch{
            if(generation===epoch&&!paused&&!document.hidden)status.textContent='Monitoring unavailable. Displayed readings are historical, not live. Retrying in 5 seconds.';
        }finally{
            clearTimer(deadline);controller=null;inFlight=false;
            if(!paused&&!stopped&&!document.hidden)timer=setTimer(poll,refreshMs());
        }
    }
    function suspend(){epoch++;clearTimer(timer);clearTimer(realtimeTimer);controller?.abort();}
    toggle.addEventListener('click',()=>{
        paused=!paused;
        suspend();
        if(refreshRate)refreshRate.disabled=!paused;
        if(typeof window!=='undefined'&&typeof window.syncTerminalSelect==='function'&&refreshRate)window.syncTerminalSelect(refreshRate);
        toggle.textContent=paused?'Resume monitoring':'Pause monitoring';
        status.textContent=paused?'Monitoring paused; displayed readings are historical.':'Resuming monitoring...';
        if(!paused)poll();
    });
    document.addEventListener('visibilitychange',()=>{suspend();if(!document.hidden){poll();loadAndRenderCharts();}});
    return {poll,dispose(){stopped=true;suspend();cards.replaceChildren();chartsContainer.replaceChildren();}};
}
if(typeof module!=='undefined'&&module.exports)module.exports={createAdminMonitor};
else {
    const monitor=createAdminMonitor({document,fetch:window.fetch.bind(window)});
    monitor.poll();
    window.addEventListener('pagehide',()=>monitor.dispose(),{once:true});
    window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
}
