'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const A=require('../public/benchmark-analytics');const R=require('../core/benchmark-reports');const JSZip=require('jszip');
const {createBenchmarkRoutes}=require('../core/benchmark-routes');
const run={runId:'01234567-89ab-cdef-0123-456789abcdef',name:'=unsafe <name> 中文',target:'local-llama',status:'completed',model:'fixture',createdAt:'2026-11-05T00:00:00Z',configuration:{promptTokenTarget:32,outputTokenLimit:16,temperature:0,seed:null},hardware:{gpus:[{name:'fixture GPU'}]},results:[{repetition:1,phase:'warmup',status:'success',durationMs:999,endToEndOutputTokensPerSecond:99},{repetition:2,phase:'measurement',status:'success',durationMs:100,endToEndOutputTokensPerSecond:10,timeToFirstTokenMs:12},{repetition:3,phase:'measurement',status:'success',durationMs:300,endToEndOutputTokensPerSecond:30},{repetition:4,phase:'measurement',status:'failed',durationMs:800},{repetition:5,phase:'measurement',status:'success',durationMs:null,promptTokensPerSecond:NaN}]};
test('analytics exclude warmups, failures and invalid/missing metrics without inventing zeros',()=>{
 assert.deepEqual(A.stats(run,'durationMs'),{count:2,average:200,median:200});
 assert.deepEqual(A.stats(run,'promptTokensPerSecond'),{count:0,average:null,median:null});
 assert.equal(A.stats(run,'timeToFirstTokenMs').average,12);
 assert.match(A.warnings([run,{...run,configuration:{...run.configuration,outputTokenLimit:32}}]).join(' '),/Workloads differ/);
 assert.match(A.warnings([run]).join(' '),/context was not recorded/);
});
test('Excel package preserves Unicode and stores formula-like labels as literal inline strings',async()=>{
 const zip=await JSZip.loadAsync(await R.xlsx(run));
 const sheet=await zip.file('xl/worksheets/sheet1.xml').async('string');
 assert.match(sheet,/中文/);assert.match(sheet,/&lt;name&gt;/);assert.doesNotMatch(sheet,/<f>/);
 assert.match(sheet,/Unavailable/);assert.match(sheet,/warmup/);assert.match(sheet,/Average/);
 for(const name of ['[Content_Types].xml','_rels/.rels','xl/workbook.xml','xl/_rels/workbook.xml.rels'])assert.ok(zip.file(name));
});
test('PDF parses every report/chart page and contains run metadata and measurements',async()=>{
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:new Uint8Array(R.pdf(run)),useSystemFonts:true});const pdf=await task.promise;
 assert.ok(pdf.numPages>=5);let text='';
 for(let i=1;i<=pdf.numPages;i++){const p=await pdf.getPage(i);text+=(await p.getTextContent()).items.map(x=>x.str).join(' ');await p.getOperatorList();}
 assert.match(text,/01234567/);assert.match(text,/warmup/);assert.match(text,/Unavailable/);assert.match(text,/Prompt processing/);await task.destroy();
});
test('history and all report formats reject anonymous/non-admin/revoked sessions',async()=>{
 let current;let reads=0;const runner={start(){},cancel(){},listRuns(){reads++;return[run]},getRun(){reads++;return run}};
 const route=createBenchmarkRoutes({runner,authenticate:r=>r.user,revalidate:()=>current});
 const request=async(url,user)=>{let status,body;await route({url,method:'GET',user},{writeHead:s=>status=s,end:b=>body=b});return {status,body};};
 for(const url of ['/api/admin/benchmarks',...['csv','json','xlsx','pdf'].map(f=>`/api/admin/benchmarks/${run.runId}/export?format=${f}`)]){
  assert.equal((await request(url,null)).status,401);assert.equal((await request(url,{id:'u',is_admin:0})).status,403);
 }
 assert.equal(reads,0);
 const admin={id:'a',is_admin:1};current=admin;
 for(const f of ['csv','json','xlsx','pdf'])assert.equal((await request(`/api/admin/benchmarks/${run.runId}/export?format=${f}`,admin)).status,200);
 current=null;assert.equal((await request(`/api/admin/benchmarks/${run.runId}/export?format=xlsx`,admin)).status,401);
});
test('analytics UI switches metrics and compares history using text-only rendering',()=>{
 const {createBenchmarkAnalyticsUI}=require('../public/admin-benchmark-analytics');
 class Element {constructor(){this.children=[];this.style={};this.listeners={};this.value='';this.selected=false;} append(...x){this.children.push(...x)} replaceChildren(...x){this.children=x} addEventListener(n,fn){this.listeners[n]=fn} get selectedOptions(){return this.children.filter(o=>o.selected)} }
 const ids=['benchmarkAnalytics','benchmarkMetric','benchmarkCompareSelect','benchmarkChart','benchmarkComparison','benchmarkCompareChart','benchmarkCompareWarning'];
 const elements=Object.fromEntries(ids.map(id=>[id,new Element()]));const document={getElementById:id=>elements[id],createElement:()=>new Element()};
 globalThis.BenchmarkAnalytics=A;
 try {const ui=createBenchmarkAnalyticsUI(document);ui.setRuns([run,{...run,runId:'other',model:'different'}]);ui.render(run);
 assert.equal(elements.benchmarkChart.children.length,run.results.length+1);
 elements.benchmarkMetric.value='durationMs';elements.benchmarkMetric.listeners.change();
 assert.match(elements.benchmarkChart.children[0].textContent,/200.00/);
 assert.equal(elements.benchmarkChart.children[1].children[1].children[0].className,'benchmark-chart-bar warmup');
 assert.equal(elements.benchmarkChart.children[2].children[1].children[0].className,'benchmark-chart-bar');
 assert.equal(elements.benchmarkChart.children.at(-1).children[2].textContent,'Unavailable');
 const refs=elements.benchmarkChart.children[2].children[1].children.slice(1);
 assert.equal(refs.length,2);assert(refs.every(r=>r.title.endsWith('200.00')));
 elements.benchmarkCompareSelect.children.forEach(o=>o.selected=true);elements.benchmarkCompareSelect.listeners.change();
 assert.equal(elements.benchmarkComparison.children.length,3);assert.match(elements.benchmarkCompareWarning.textContent,/tokenizers/);
 assert.match(elements.benchmarkComparison.children[1].children[0].textContent,/unsafe <name>/);
 }finally{delete globalThis.BenchmarkAnalytics;}
});
test('XLSX worksheet XML has numeric summary values and complete results',async()=>{
 const {DOMParser}=require('@xmldom/xmldom');const zip=await JSZip.loadAsync(await R.xlsx(run));
 const errors=[];const parser=new DOMParser({onError:(level,message)=>errors.push(level+': '+message)});
 for(const file of Object.values(zip.files).filter(f=>!f.dir))parser.parseFromString(await file.async('string'),'application/xml');
 assert.deepEqual(errors,[]);
 const doc=parser.parseFromString(await zip.file('xl/worksheets/sheet1.xml').async('string'),'application/xml');
 const rows=Array.from(doc.getElementsByTagName('row'));
 const summary=rows.find(r=>r.textContent.startsWith(A.metrics.durationMs));assert(summary);
 const cells=Array.from(summary.getElementsByTagName('c'));assert.equal(cells[1].getElementsByTagName('v')[0].textContent,'200');assert.equal(cells[2].getElementsByTagName('v')[0].textContent,'200');
 assert.equal(rows.filter(r=>r.textContent.includes('warmup')).length,1);
 assert.equal(rows.length,A.rows(run).length);
});
test('runner never persists or exports synthetic prompts, output text or upstream secrets', {timeout:5000},async()=>{
 const {DatabaseSync}=require('node:sqlite');const {initializeSchema}=require('../core/database-schema');const {createBenchmarkRunner,exportCsv}=require('../core/benchmark-runner');
 const db=new DatabaseSync(':memory:');initializeSchema(db);let prompt;const marker='SYNTHETIC_PRIVATE_RESPONSE_481';
 const runner=createBenchmarkRunner({db,readSlots:async()=>[{is_processing:false}],getModel:async()=>'fixture',createChatCompletion:async body=>{prompt=body.messages[0].content;return new Response('data: '+JSON.stringify({choices:[{delta:{content:marker}}],api_key:marker,usage:{prompt_tokens:32,completion_tokens:3}})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
 try{
 const started=await runner.start('admin',{name:'fixture',target:'local-llama',promptTokenTarget:32,outputTokenLimit:16,repetitions:1,warmupRepetitions:0,concurrency:1,temperature:0,seed:null,timeoutMs:1000});
 while(runner.activeRunId)await new Promise(setImmediate);
 const saved=runner.getRun(started.runId);assert.equal(saved.status,'completed');
 const zip=await JSZip.loadAsync(await R.xlsx(saved));
 for(const output of [JSON.stringify(saved),exportCsv(saved),R.pdf(saved).toString(),await zip.file('xl/worksheets/sheet1.xml').async('string')]){assert(!output.includes(marker));assert(!output.includes(prompt));}
 }finally{await runner.stop();db.close();}
});
test('maximal fixture PDF text remains within page margins and reference labels do not overlap',async()=>{
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const large={...run,name:'Long name '.repeat(8),hardware:{gpus:[{name:'GPU'.repeat(80)}]},results:Array.from({length:25},(_,i)=>({...run.results[1],repetition:i+1,phase:i<5?'warmup':'measurement'}))};
 const task=getDocument({data:new Uint8Array(R.pdf(large)),useSystemFonts:true});const pdf=await task.promise;
 try{for(let i=1;i<=pdf.numPages;i++){const p=await pdf.getPage(i);const items=(await p.getTextContent()).items.filter(x=>x.str?.trim());for(const item of items){assert(item.transform[4]>=25);assert(item.transform[4]+item.width<=587);assert(item.transform[5]>=35&&item.transform[5]<=765);}
 const labels=items.filter(x=>/^(Average|Median):/.test(x.str));if(labels.length===2)assert(Math.abs(labels[0].transform[5]-labels[1].transform[5])>=14);
 await p.getOperatorList();}}finally{await task.destroy();}
});
