'use strict';
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
function dimensions(b){
 if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.toString('ascii',12,16)==='IHDR')return [b.readUInt32BE(16),b.readUInt32BE(20)];
 if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'){
  const kind=b.toString('ascii',12,16);
  if(kind==='VP8X'&&b.length>=30){if(b[20]&2)throw Error();return [1+b.readUIntLE(24,3),1+b.readUIntLE(27,3)];}
  if(kind==='VP8L'&&b.length>=25&&b[20]===47){const n=b.readUInt32LE(21);return [(n&16383)+1,((n>>>14)&16383)+1];}
  if(kind==='VP8 '&&b.length>=30&&b[23]===157&&b[24]===1&&b[25]===42)return [b.readUInt16LE(26)&16383,b.readUInt16LE(28)&16383];
 }
 if(b[0]===255&&b[1]===216){let i=2;while(i+4<b.length){if(b[i++]!==255)throw Error();while(b[i]===255)i++;const marker=b[i++];if(marker===218||marker===217)break;const n=b.readUInt16BE(i);if(n<2||i+n>b.length)throw Error();if([192,193,194].includes(marker)&&n>=8)return [b.readUInt16BE(i+5),b.readUInt16BE(i+3)];i+=n;}}
 throw Error('Unsupported image');
}
function validate(bytes,max){if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>max)throw Error('Image exceeds upload limit');const [w,h]=dimensions(bytes);if(w<1||h<1||w>8192||h>8192||w*h>16000000)throw Error('Image dimensions exceed limits');return [w,h];}
if(!isMainThread){(async()=>{const b=Buffer.from(workerData.bytes),[w,h]=validate(b,workerData.max);const {loadImage,createCanvas}=require('@napi-rs/canvas');const image=await loadImage(b);if(image.width!==w||image.height!==h)throw Error();const canvas=createCanvas(w,h);canvas.getContext('2d').drawImage(image,0,0);const bytes=await canvas.encode('png');if(bytes.length>workerData.max)throw Error();parentPort.postMessage({bytes,width:w,height:h});})().catch(()=>parentPort.postMessage({error:true}));}
function decode(bytes,max){validate(bytes,max);return new Promise((resolve,reject)=>{const worker=new Worker(__filename,{workerData:{bytes,max},resourceLimits:{maxOldGenerationSizeMb:128}});let done=false;const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate().finally(()=>err?reject(Error('Invalid, oversized or undecodable image')):resolve({...value,bytes:Buffer.from(value.bytes)}));};const timer=setTimeout(()=>finish(true),10000);worker.once('message',m=>finish(m.error,m));worker.once('error',()=>finish(true));worker.once('exit',()=>finish(true));});}
module.exports={decode,dimensions,validate};
