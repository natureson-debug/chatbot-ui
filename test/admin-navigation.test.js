'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function loadAdminClick(userAgent){
 const source=fs.readFileSync('public/app.js','utf8');
 const slice=source.slice(source.indexOf('const adminConsoleButton ='),source.indexOf('loginForm.addEventListener("submit"'));
 let click;
 const calls=[];
 const button={addEventListener(_name,fn){click=fn;}};
 const context={
  document:{getElementById:id=>id==='adminConsoleButton'?button:undefined},
  navigator:{userAgent},
  window:{
   open:(...args)=>{calls.push(['open',...args]);},
   location:{assign:url=>calls.push(['assign',url])}
  }
 };
 vm.createContext(context);
 vm.runInContext(slice,context);
 return {click,calls};
}
test('desktop Electron opens Admin inside the existing window',()=>{
 const {click,calls}=loadAdminClick('Mozilla/5.0 Electron/45.2.3');
 click();
 assert.deepEqual(calls,[['assign','/admin']]);
});
test('browser behavior keeps a new noopener tab',()=>{
 const {click,calls}=loadAdminClick('Mozilla/5.0 Safari/605.1.15');
 click();
 assert.deepEqual(calls,[['open','/admin','_blank','noopener']]);
});
test('Electron main denies new windows and external navigation',()=>{
 const source=fs.readFileSync('desktop/main.cjs','utf8');
 assert(source.includes("setWindowOpenHandler(() => ({ action: 'deny' }))"));
 assert(source.includes("window.webContents.on('will-navigate', guard)"));
 assert(source.includes("window.webContents.on('will-redirect', guard)"));
});
