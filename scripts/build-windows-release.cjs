'use strict';
// REL-01: offline development packaging only; never import application startup.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const repo=path.resolve(__dirname,'..'),dist=path.join(repo,'dist'),out=path.join(dist,'AIChatbot-1.0.0-win-x64');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const git=(...args)=>cp.execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
const excluded=new Set(['test','tests','__tests__','fixtures','__fixtures__','example','examples','benchmark','benchmarks','.git','.github','.cache','coverage','node_modules']);
const forbidden=/(^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:db|sqlite|sqlite3|gguf|log|pem|key|pfx|p12|bak|tmp)|chatbot-(?:ai-config|connections|extensions)\.json)$/i;
const testFile=n=>/^(?:tests?|spec)(?:[.-]|$)|\.(?:test|spec)[.-]/i.test(n);
const files=[],packages=[];
function safe(p){if(fs.lstatSync(p).isSymbolicLink())throw Error('Symlink/reparse source refused: '+p);}
function put(relative,bytes){
 if(forbidden.test(relative))throw Error('Forbidden payload file: '+relative);
 const target=path.join(out,relative);if(!target.startsWith(out+path.sep))throw Error('Path escape');
 if(/\.(?:js|cjs|mjs|json|html|css|ps1|md|txt)$/i.test(relative)&&/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{32,}|\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.-]{24,}/.test(bytes.toString()))throw Error('Potential secret: '+relative);
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});
 files.push({path:relative.replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});
}
function copyTree(source,relative){safe(source);for(const e of fs.readdirSync(source,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
 if(excluded.has(e.name.toLowerCase())||e.name.startsWith('.')||testFile(e.name))continue;
 const p=path.join(source,e.name),r=relative+'/'+e.name;safe(p);
 if(e.isDirectory())copyTree(p,r);else if(e.isFile()&&!forbidden.test(r))put(r,fs.readFileSync(p));
}}
function build(){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('Build requires Windows x64 dependency installation');
 const pkg=JSON.parse(fs.readFileSync(path.join(repo,'package.json'))),lock=JSON.parse(fs.readFileSync(path.join(repo,'package-lock.json')));
 if(pkg.version!=='1.0.0'||lock.lockfileVersion!==3)throw Error('Unexpected package version/lock schema');
 const canonical=o=>JSON.stringify(Object.entries(o||{}).sort(([a],[b])=>a.localeCompare(b,'en')));
 if(canonical(pkg.dependencies)!==canonical(lock.packages[''].dependencies))throw Error('Dependency declarations differ from lock');
 if(fs.existsSync(dist))safe(dist);else fs.mkdirSync(dist);
 if(fs.existsSync(out))throw Error('Output already exists; preserve it and select a clean workspace before rebuilding');
 fs.mkdirSync(out);
 // Explicit tracked application allowlist: never traverse installation data/config.
 const application=git('ls-files','--','server.js','db.js','auth.js','setup-admin.js','core','public','scripts/initialize-database.cjs').split('\n').filter(n=>/\.(?:js|cjs|json|ps1|html|css|png|svg|ico|woff2?)$/i.test(n));
 for(const n of application){safe(path.join(repo,n));put(n,fs.readFileSync(path.join(repo,n)));}
 for(const n of ['package.json','package-lock.json'])put(n,fs.readFileSync(path.join(repo,n)));
 const matches=(list,value)=>!list||(!list.includes('!'+value)&&(!list.some(x=>!x.startsWith('!'))||list.includes(value)));
 for(const [loc,entry] of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b,'en'))){
  if(!loc||entry.dev||!matches(entry.os,'win32')||!matches(entry.cpu,'x64'))continue;
  if(!loc.startsWith('node_modules/')||loc.includes('..')||entry.link)throw Error('Unsupported dependency layout');
  const dir=path.join(repo,loc);safe(dir);const installed=JSON.parse(fs.readFileSync(path.join(dir,'package.json')));
  if(installed.version!==entry.version)throw Error('Installed dependency version mismatch: '+loc);
  copyTree(dir,loc);packages.push({path:loc,name:installed.name,version:installed.version,license:installed.license||'UNSPECIFIED',lockIntegrity:entry.integrity||null});
 }
 const readme=`# AIChatbot 1.0.0 — Windows x64 development payload

Not an installer, signed release or production deployment qualification.
Install official Node.js 24 x64 separately (build host: ${process.version}); node:sqlite is required.
Node is not bundled: obtain its license/third-party notices with the official runtime.
Application package declares ISC; authorship/distribution rights still require release review.
Dependencies retain supplied license/notice files; see packaging-manifest.json for package licenses.
No inference engines, models, GPU drivers, TLS proxy, accounts or configuration are bundled.

## First installation only

Extract to a user-controlled development folder. Use a fresh PowerShell session and set:

\`\`\`powershell
$env:CHATBOT_HOME = Join-Path $env:LOCALAPPDATA 'AIChatbot'
$env:CHATBOT_DATA_ROOT = $env:CHATBOT_HOME
$env:CHATBOT_STORAGE_MODE = 'per-user'
$env:CHATBOT_DB_PATH = Join-Path $env:CHATBOT_HOME 'data\\chatbot.db'
$env:CHATBOT_PORT = '3000'
New-Item -ItemType Directory -Force (Join-Path $env:CHATBOT_HOME 'data'), (Join-Path $env:CHATBOT_HOME 'config')
node scripts/initialize-database.cjs --create-new-database
\`\`\`

Run initialization only for a new installation: it refuses an existing file.
Normal startup fails closed if the expected database is missing; never initialize as recovery.
Set CHATBOT_ADMIN_USERNAME and CHATBOT_ADMIN_PASSWORD through your approved secret-input
mechanism, run node setup-admin.js once, then remove the password environment variable.
Do not put credentials in command history or configuration templates.
On subsequent starts set the same storage variables, then run node server.js from this folder.
Use Ctrl+C in its owning console for graceful shutdown. No autostart is installed.

The backend binds 127.0.0.1. Existing server-mode cookies retain Secure: browser login
requires an appropriately trusted HTTPS reverse proxy, provisioned separately. Do not
disable cookie/TLS protections. This payload does not provide a turnkey HTTP login workaround.
Configure existing external llama.cpp/Ollama connections in Admin -> AI Providers.
No provider is needed for startup; no local engine should be managed from this payload.
Do not enable legacy Windows task/restart controls; production task infrastructure is absent.
Cloud gates and credential behavior are unchanged. No runtime connectivity was tested.

## Reproducibility and limitations

Build command: node scripts/build-windows-release.cjs in the source workspace.
Requires installed lockfile-matching Windows x64 production dependencies; no network install
or lifecycle scripts are run by packaging. Only compatible lock entries are copied; dependency
tests/examples/cache are omitted. Installed bytes are hashed, not independently authenticated
against npm tarball integrity. Repeating with identical source/dependency bytes gives identical
payload hashes. Dirty application files are included deliberately and identified in the manifest.
The builder refuses an existing destination rather than deleting it. Partial failure output is
not valid. Native module loading, first-run and browser acceptance require a later isolated test.
`;
 put('INSTALL.md',Buffer.from(readme));
 // The three requested checks: build, required payload, exclusion inspection.
 for(const n of ['server.js','db.js','auth.js','setup-admin.js','scripts/initialize-database.cjs','core/database-schema.js','core/provider-presets.json','public/index.html','public/admin.html','public/app.js','public/style.css','node_modules/@modelcontextprotocol/sdk/package.json','node_modules/@napi-rs/canvas-win32-x64-msvc/package.json'])if(!fs.existsSync(path.join(out,n)))throw Error('Required asset missing: '+n);
 for(const f of files)if(forbidden.test(f.path)||testFile(path.basename(f.path))||f.path.split('/').some(x=>excluded.has(x.toLowerCase())&&x!=='node_modules'))throw Error('Excluded content present: '+f.path);
 const manifest={schemaVersion:1,name:'AIChatbot',version:'1.0.0',target:'win32-x64',developmentOnly:true,sourceCommit:git('rev-parse','HEAD'),sourceChanges:git('status','--porcelain','--',...application),nodePrerequisite:'24.x x64',nodeBundled:false,buildNode:process.version,dependencies:packages,checks:{build:'PASS',requiredAssets:'PASS',allowlistAndSecretPatternInspection:'PASS'},limitations:['Pattern scanning cannot prove absence of arbitrary secrets','Installed dependency contents are pinned by payload hashes, not npm archive authentication','No application startup or native module execution performed'],files:files.sort((a,b)=>a.path.localeCompare(b.path,'en'))};
 fs.writeFileSync(path.join(out,'packaging-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({directory:out,fileCount:files.length+1,bytes:files.reduce((n,f)=>n+f.bytes,0)+fs.statSync(path.join(out,'packaging-manifest.json')).size,productionPackages:packages.length,checks:manifest.checks},null,2));
}
try{build();}catch(e){console.error('Packaging failed: '+e.message);process.exitCode=1;}
