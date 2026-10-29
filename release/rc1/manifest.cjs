'use strict';
// Source-only preparation inventory. Never imports the application or reads data/config secrets.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const files=['server.js','db.js','auth.js','package.json'];
function scan(dir){for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
 const p=dir+'/'+entry.name;if(entry.isSymbolicLink())throw Error('Symlink not permitted in release inventory');
 if(entry.isDirectory())scan(p);else if(/\.(js|cjs|cpp|h|html|css|md|json|ps1)$/.test(p))files.push(p);
}}
for(const dir of ['core','public','test','scripts','release/rc1/supervisor'])scan(dir);
const manifest={kind:'source-preparation-only',productionApproved:false,nodeMajor:24,
 files:files.sort().map(file=>({file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}))};
const target=path.join(__dirname,'source-manifest.json');
if(process.argv.includes('--verify')){
 const previous=JSON.parse(fs.readFileSync(target,'utf8'));if(JSON.stringify(previous)!==JSON.stringify(manifest))throw Error('SOURCE_MANIFEST_MISMATCH');console.log('Source preparation manifest matches');
}else{fs.writeFileSync(target,JSON.stringify(manifest,null,2)+'\n');console.log('Source preparation manifest written; no production artifacts included');}
