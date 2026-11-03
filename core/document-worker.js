'use strict';
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
 const bytes=Buffer.from(workerData.bytes);let text='';
 if(workerData.type==='pdf'){
  const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');const doc=await pdf.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true}).promise;
  try{if(doc.numPages>50)throw Error();for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const content=await page.getTextContent();text+=content.items.map(x=>x.str||'').join(' ')+'\n';if(text.length>200000)throw Error();}}finally{await doc.destroy();}
 }else if(workerData.type==='docx'){text=(await require('mammoth').extractRawText({buffer:bytes})).value;}
 else throw Error();
 if(text.length>200000||!text.trim())throw Error();parentPort.postMessage({text});
})().catch(()=>parentPort.postMessage({error:'Document extraction failed or exceeded limits'}));
