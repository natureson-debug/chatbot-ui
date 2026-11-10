'use strict';
function createBenchmarkAnalyticsUI(document) {
 const A=globalThis.BenchmarkAnalytics;
 const root=document.getElementById('benchmarkAnalytics');
 if(!A||!root)return null;
 let current=null,runs=[];
 const metric=document.getElementById('benchmarkMetric');
 const choices=document.getElementById('benchmarkCompareSelect');
 const chart=document.getElementById('benchmarkChart');
 const table=document.getElementById('benchmarkComparison');
 const comparisonChart=document.getElementById('benchmarkCompareChart');
 const warning=document.getElementById('benchmarkCompareWarning');
 const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
 for(const [key,label] of Object.entries(A.metrics)){const o=node('option',label);o.value=key;metric.append(o);}
 function bars(container,points,references={}){
  container.replaceChildren();
  const max=Math.max(1,...points.map(p=>A.valid(p.value)?p.value:0));
  const summary=node('p',Object.keys(references).length ? `Average: ${A.format(references.average)}; median: ${A.format(references.median)}. Successful measured repetitions only.` : 'Comparison: mean of available successful measured repetitions for the selected metric.');container.append(summary);
  for(const p of points){
   const line=node('div');line.className='benchmark-chart-row';
   const label=node('span',p.label);const meter=node('div');meter.className='benchmark-chart-track';
   const fill=node('div');fill.className='benchmark-chart-bar'+(p.warmup?' warmup':'');
   fill.style.width=(A.valid(p.value)?p.value/max*100:0)+'%';meter.append(fill);
   for(const [name,v] of Object.entries(references))if(['average','median'].includes(name)&&A.valid(v)){const mark=node('span');mark.className='benchmark-chart-reference '+name;mark.style.left=Math.min(100,v/max*100)+'%';mark.title=name+': '+A.format(v);meter.append(mark);}
   const value=node('span',A.format(p.value));line.title=p.label+': '+A.format(p.value);line.tabIndex=0;line.append(label,meter,value);container.append(line);
  }
 }
 function draw(){
  const key=metric.value||Object.keys(A.metrics)[0];
  if(current)bars(chart,(current.results||[]).map(r=>({label:`${r.repetition}: ${r.phase} / ${r.status}`,value:r[key],warmup:r.phase==='warmup'})),A.stats(current,key));
  const selected=new Set(Array.from(choices.selectedOptions).map(o=>o.value));
  const compare=runs.filter(r=>selected.has(r.runId));table.replaceChildren();comparisonChart.replaceChildren();
  warning.textContent=compare.length<2?'Select two to six saved runs to compare.':A.warnings(compare).join(' ');
  if(compare.length<2)return;
  if(compare.length>6){warning.textContent='Select at most six runs for a readable comparison.';return;}
  const header=node('tr');for(const label of ['Run / date','Model / provider','Hardware','Context','Prompt target / output limit','Measured input / output totals','Throughput avg / median','Latency avg / median','TTFT avg / median','Prompt speed avg / median','Success / failed / cancelled'])header.append(node('th',label));table.append(header);
  for(const run of compare){
   const pair=k=>{const s=A.stats(run,k);return A.format(s.average)+' / '+A.format(s.median);};
   const measured=(run.results||[]).filter(r=>r.phase==='measurement');
   const total=k=>measured.length&&measured.every(r=>A.valid(r[k]))?measured.reduce((n,r)=>n+r[k],0):'Unavailable';
   const row=node('tr');
   for(const v of [`${run.name} (${run.runId}) ${run.createdAt}`,`${run.model||'Unavailable'} / ${run.target||'Unavailable'}`,JSON.stringify(run.hardware??'Unavailable'),run.configuration?.contextSize??'Unavailable',`${run.configuration?.promptTokenTarget??'Unavailable'} / ${run.configuration?.outputTokenLimit??'Unavailable'}`,`${total('inputTokens')} / ${total('outputTokens')}`,pair('endToEndOutputTokensPerSecond'),pair('durationMs'),pair('timeToFirstTokenMs'),pair('promptTokensPerSecond'),['success','failed','cancelled'].map(s=>measured.filter(r=>r.status===s).length).join(' / ')])row.append(node('td',String(v)));
   table.append(row);
  }
  bars(comparisonChart,compare.map(r=>({label:r.name+' / '+r.runId,value:A.stats(r,key).average})));
 }
 metric.addEventListener('change',draw);choices.addEventListener('change',draw);
 return {render(run){current=run;draw();},setRuns(next){const selected=new Set(Array.from(choices.selectedOptions).map(o=>o.value));runs=next.filter(r=>!['running','queued'].includes(r.status));choices.replaceChildren();for(const r of runs){const o=node('option',r.name+' / '+r.createdAt+' / '+r.status);o.value=r.runId;o.selected=selected.has(r.runId);choices.append(o);}draw();}};
}
if(typeof module!=='undefined'&&module.exports)module.exports={createBenchmarkAnalyticsUI};
