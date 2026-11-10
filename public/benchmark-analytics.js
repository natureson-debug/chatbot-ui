'use strict';
// Shared pure analytics for browser and report generation. No stored data is rewritten.
(function(root) {
 const metrics = {
  endToEndOutputTokensPerSecond: 'End-to-end output throughput (tokens/s, derived)',
  durationMs: 'End-to-end request latency (ms, client observed)',
  timeToFirstTokenMs: 'Time to first text delta (TTFT, ms, client observed)',
  promptTokensPerSecond: 'Prompt processing throughput (tokens/s, server timing)'
 };
 const valid = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
 function stats(run, key) {
  const values=(run.results||[]).filter(r=>r.phase==='measurement'&&r.status==='success').map(r=>r[key]).filter(valid).sort((a,b)=>a-b);
  return {count:values.length, average:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,
   median:values.length?(values[Math.floor((values.length-1)/2)]+values[Math.ceil((values.length-1)/2)])/2:null};
 }
 function warnings(runs) {
  const warnings=[];
  const fields=['target','promptTokenTarget','outputTokenLimit','concurrency','temperature','seed','timeoutMs','warmupRepetitions','repetitions'];
  if(runs.length>1 && fields.some(k=>new Set(runs.map(r=>JSON.stringify(k==='target'?r.target:r.configuration?.[k]))).size>1)) warnings.push('Workloads differ: token targets, generation settings, warm-ups or repetition counts are not identical. Do not interpret this as a controlled comparison.');
  if(runs.some(r=>!valid(r.configuration?.contextSize))) warnings.push('Runtime context was not recorded for one or more runs; workload equivalence cannot be verified.');
  if(runs.length>1 && new Set(runs.map(r=>r.model)).size>1) warnings.push('Models/tokenizers differ; equal prompt targets do not guarantee equal actual token counts.');
  return warnings;
 }
 const format=x=>valid(x)?x.toFixed(2):'Unavailable';
 function rows(run) {
  const out=[['Benchmark report',run.name],['Run ID',run.runId],['Date',run.createdAt],['Finished',run.finishedAt],['Status',run.status],['Provider / target',run.target],['Model',run.model],['Hardware',JSON.stringify(run.hardware??null)],['Context',run.configuration?.contextSize??'Unavailable']];
  for(const [k,v] of Object.entries(run.configuration||{})) out.push(['Configuration: '+k,v??'Unavailable']);
  out.push(['Method','Averages/medians use successful measured repetitions only. Warm-ups and failures are excluded.'],['Timing','TTFT is first text delta arrival. Output throughput includes prompt/network time, not server decode speed.']);
  for(const warning of warnings([run]))out.push(['Warning',warning]);
  out.push(['Metric','Average','Median','Available samples']);
  for(const [key,label] of Object.entries(metrics)){const s=stats(run,key);out.push([label,s.average??'Unavailable',s.median??'Unavailable',s.count]);}
  const measured=(run.results||[]).filter(r=>r.phase==='measurement');
  out.push(['Measured success / failure / cancelled',...['success','failed','cancelled'].map(s=>measured.filter(r=>r.status===s).length)]);
  out.push(['Repetition','Phase','Status','Input tokens','Output tokens',...Object.values(metrics),'Error']);
  for(const r of run.results||[]) out.push([r.repetition,r.phase,r.status,r.inputTokens??'Unavailable',r.outputTokens??'Unavailable',...Object.keys(metrics).map(k=>valid(r[k])?r[k]:'Unavailable'),r.errorCategory??'']);
  return out;
 }
 const api={metrics,valid,stats,warnings,format,rows};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BenchmarkAnalytics=api;
})(globalThis);
