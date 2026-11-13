'use strict';
const JSZip=require('jszip');
const A=require('../public/benchmark-analytics');
const xml=s=>String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function xlsx(run){
 const zip=new JSZip();
 const rows=A.rows(run);
 const sheet=rows.map((row,i)=>`<row r="${i+1}">${row.map((v,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" ${typeof v==='number'&&Number.isFinite(v)?'':'t="inlineStr"'}>${typeof v==='number'&&Number.isFinite(v)?`<v>${v}</v>`:`<is><t xml:space="preserve">${xml(v)}</t></is>`}</c>`).join('')}</row>`).join('');
 zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
 zip.file('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Benchmark" sheetId="1" r:id="rId1"/></sheets></workbook>');
 zip.file('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="62" customWidth="1"/><col min="2" max="10" width="26" customWidth="1"/></cols><sheetData>${sheet}</sheetData></worksheet>`);
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
// Small fixed-layout PDF writer: no active content, external resources or arbitrary PDF input.
// Non-ASCII characters are represented by reversible Unicode escapes, not silently dropped.
function pdf(run){
 const ascii=s=>String(s).replace(/[^\x20-\x7e]/gu,c=>'\\u{'+c.codePointAt(0).toString(16)+'}');
 const escape=s=>ascii(s).replace(/[\\()]/g,'\\$&');
 const pages=[];let lines=[];
 for(const row of A.rows(run)){
  const text=row.map(v=>v??'Unavailable').join(' | ');
  const printable=ascii(text);
  for(let i=0;i<printable.length;i+=104) {lines.push(printable.slice(i,i+104));if(lines.length===48){pages.push(lines);lines=[];}}
 }
 if(lines.length)pages.push(lines);
 const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>',null,'<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'];
 const pageIds=[];
 for(const [index,page] of pages.entries()){
  const id=objects.length;pageIds.push(id);
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id+1} 0 R >>`);
  const stream=`BT /F1 8 Tf 36 756 Td 14 TL (${escape('AIChatbot Benchmark report - '+(index+1))}) Tj T* `+page.map(s=>`(${escape(s)}) Tj T*`).join(' ')+' ET';
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
 }
 // Four vector chart pages, using the same values and successful-measurement references.
 for(const [key,label] of Object.entries(A.metrics)){
  const id=objects.length;pageIds.push(id);
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id+1} 0 R >>`);
  const points=run.results||[];const max=Math.max(1,...points.map(r=>A.valid(r[key])?r[key]:0));
  let stream=`BT /F1 8 Tf 30 755 Td (${escape(label)}) Tj 0 -16 Td (Gray = warm-up; blue = measurement; unavailable values omitted.) Tj ET\n`;
  const s=A.stats(run,key);let references='';let legendY=700;
  for(const [name,value] of [['Average',s.average],['Median',s.median]])if(A.valid(value)){const y=100+value/max*500;references+=`0 G [4 3] 0 d 50 ${y} m 560 ${y} l S [] 0 d 0 g BT /F1 8 Tf 50 ${legendY} Td (${name}: ${value.toFixed(2)}) Tj ET\n`;legendY-=16;}
  points.forEach((r,i)=>{const x=50+i*500/Math.max(1,points.length);if(A.valid(r[key]))stream+=`${r.phase==='warmup'?'0.6 0.6 0.6':'0.1 0.4 0.7'} rg ${x} 100 ${Math.max(2,400/Math.max(1,points.length))} ${r[key]/max*500} re f\n`;stream+=`0 g BT /F1 8 Tf ${x} 85 Td (${i+1}) Tj ET\n`;});
  stream+=references;stream+='0 g BT /F1 8 Tf 50 65 Td (Repetition order; details and unavailable values in measurement rows.) Tj ET';
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
 }
 objects[2]=`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(i=>i+' 0 R').join(' ')}] >>`;
 let text='%PDF-1.4\n';const offsets=[0];
 for(let i=1;i<objects.length;i++){offsets[i]=Buffer.byteLength(text);text+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
 const start=Buffer.byteLength(text);text+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 return Buffer.from(text);
}
module.exports={xlsx,pdf};
