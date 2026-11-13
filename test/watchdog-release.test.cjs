'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {FILES,hash,build,validate,selectRollback}=require('../scripts/watchdog-release.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watchdog-offline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const sources={};
 for(const name of FILES){const repo=path.join(__dirname,'..','scripts',name);
 const text=!['start-chatbot-ai.ps1','chatbot-lifecycle-lock.ps1'].includes(name)?fs.readFileSync(repo,'utf8'):name==='chatbot-lifecycle-lock.ps1'?"# fixture\n$identity='Global\\Chatbot.LlamaLifecycle'\n":"# harmless launcher fixture\n$output = @(& $ServerExe --list-devices 2>&1)\n$ConfigFile='C:\\AI\\config\\chatbot-ai-config.json'\n$ApiKeyFile='C:\\AI\\config\\llama-api-key.txt'\n$LogDir='C:\\AI\\logs'\n$LlamaDir='C:\\Users\\Admin\\Downloads\\Chatbot-upgrade-17E2-20261015\\llama-b11609-cuda12.4'\n";
 const file=path.join(dir,name);fs.writeFileSync(file,text);sources[name]={path:file,sha256:hash(text)};}
 const paths={scripts:'C:\\Protected\\releases\\v1',runtime:'C:\\Protected\\runtime',executable:'C:\\Protected\\runtime\\llama-server.exe',config:'C:\\ProtectedData\\config',models:'C:\\ProtectedData\\models',logs:'C:\\ProtectedData\\state'};
 const plan={releaseId:'v1',sourceCommit:'a'.repeat(40),sources,paths,runtimeDependencies:[{path:paths.executable,sha256:'b'.repeat(64)}]};
 const built=build(plan,dir);
 const providers={inspectSecurity:p=>({path:p,ancestorsVerified:true,effectiveAccessVerified:true,reparsePoint:false,untrustedWrite:false,replaceable:false}),inspectRuntime:p=>({path:p,sha256:'b'.repeat(64),regularFile:true,dependenciesComplete:true})};
 const check=()=>validate(built.root,built.manifestSha256,providers);
 function mutate(fn){const file=path.join(built.root,'manifest.json');const m=JSON.parse(fs.readFileSync(file));fn(m);fs.writeFileSync(file,JSON.stringify(m));built.manifestSha256=hash(fs.readFileSync(file));}
 return {dir,plan,built,providers,check,mutate};
}
test('valid fixture release preserves strict ownership and maps lowercase key comparison',t=>{const f=fixture(t);assert(f.check().valid);assert.equal(fs.readdirSync(f.built.root).length,8);const s=fs.readFileSync(path.join(f.built.root,'chatbot-owned-backend.ps1'),'utf8');assert(s.includes("'c:\\protecteddata\\config\\llama-api-key.txt'"));assert(s.includes('$launcherArguments.Count -ne 6'));});
test('missing file',t=>{const f=fixture(t);fs.unlinkSync(path.join(f.built.root,FILES[0]));assert(!f.check().valid);});
test('hash mismatch',t=>{const f=fixture(t);fs.appendFileSync(path.join(f.built.root,FILES[0]),'# changed');assert.equal(f.check().reason,'file-hash-mismatch');});
test('unexpected file',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.built.root,'secret.txt'),'fixture');assert(!f.check().valid);});
test('writable ancestor',t=>{const f=fixture(t);const original=f.providers.inspectSecurity;f.providers.inspectSecurity=p=>({...original(p),untrustedWrite:true});assert.equal(f.check().reason,'writable-ancestor');});
test('reparse point',t=>{const f=fixture(t);const original=f.providers.inspectSecurity;f.providers.inspectSecurity=p=>({...original(p),reparsePoint:true});assert.equal(f.check().reason,'reparse-point');});
test('invalid manifest',t=>{const f=fixture(t);f.mutate(m=>m.schemaVersion=3);assert.equal(f.check().reason,'invalid-manifest');});
test('traversal',t=>{const f=fixture(t);f.mutate(m=>m.files[0].path='../outside.ps1');assert.equal(f.check().reason,'invalid-file-path');});
test('incorrect entry point',t=>{const f=fixture(t);f.mutate(m=>m.entryPoints.launcher='Restart-ChatbotAI.ps1');assert.equal(f.check().reason,'invalid-entry-point');});
test('missing runtime dependency',t=>{const f=fixture(t);f.providers.inspectRuntime=()=>null;assert.equal(f.check().reason,'runtime-unverified');f.mutate(m=>m.runtimeDependencies=[]);assert.equal(f.check().reason,'missing-runtime-dependency');});
test('unverifiable security and default validator fail closed',t=>{const f=fixture(t);assert.equal(validate(f.built.root,f.built.manifestSha256).reason,'security-unverified');f.providers.inspectSecurity=()=>({});assert.equal(f.check().reason,'security-unverified');});
test('rollback requires trusted manifest and validation',t=>{const f=fixture(t);assert.equal(selectRollback(f.built.root,f.built.manifestSha256,f.providers).releaseId,'v1');assert.throws(()=>selectRollback(f.built.root,'d'.repeat(64),f.providers),/rollback-unverified/);});
test('source hash, overwrite and injection rejection before writes',t=>{const f=fixture(t);assert.throws(()=>build(f.plan,f.dir),/release-exists/);f.plan.releaseId='v2';f.plan.paths.config="C:\\Data\\bad'";assert.throws(()=>build(f.plan,f.dir),/invalid-reference/);f.plan.paths.config='C:\\Data\\config';f.plan.sources[FILES[0]].sha256='f'.repeat(64);assert.throws(()=>build(f.plan,f.dir),/source-hash-mismatch/);assert(!fs.existsSync(path.join(f.dir,'v2')));});
test('wrong lock and synthetic secret rejection',t=>{const f=fixture(t);f.plan.releaseId='v2';const s=f.plan.sources['chatbot-lifecycle-lock.ps1'];fs.writeFileSync(s.path,'# wrong lock');s.sha256=hash(fs.readFileSync(s.path));assert.throws(()=>build(f.plan,f.dir),/lock-identity-mismatch/);fs.writeFileSync(s.path,'-----BEGIN PRIVATE KEY-----');s.sha256=hash(fs.readFileSync(s.path));assert.throws(()=>build(f.plan,f.dir),/secret-material/);});
test('transformed PowerShell scripts parse without execution',{skip:process.platform!=='win32'},t=>{
 const f=fixture(t);
 const r=require('node:child_process').spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
 ['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; foreach($f in Get-ChildItem -LiteralPath $env:RELEASE_TEST_ROOT -Filter *.ps1){$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$null,[ref]$e);if($e){exit 1}}"],
 {env:{...process.env,RELEASE_TEST_ROOT:f.built.root},timeout:10000,windowsHide:true,encoding:'utf8'});
 assert.equal(r.status,0,'PowerShell parse failed');
});
test('actual staged enumeration guards enforce directory, executable, failures and restoration',{skip:process.platform!=='win32'||process.env.CHATBOT_RELEASE_PARSE_ONLY==='1'},t=>{
 const f=fixture(t);
 const r=require('node:child_process').spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
 ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'staged-gpu-enumeration.ps1'),'-Release',f.built.root],
 {timeout:10000,windowsHide:true,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/PASS: 16 staged enumeration cases/);
 assert.equal(validate(f.built.root,f.built.manifestSha256).reason,'security-unverified');
});
test('changed enumeration source fails closed before staging',t=>{
 const f=fixture(t);f.plan.releaseId='v2';const s=f.plan.sources['start-chatbot-ai.ps1'];
 fs.writeFileSync(s.path,'# missing enumeration');s.sha256=hash(fs.readFileSync(s.path));
 assert.throws(()=>build(f.plan,f.dir),/enumeration-source-changed/);
 assert(!fs.existsSync(path.join(f.dir,'v2')));
});
function v2plan(f){
 const {scripts,runtime,executable,models}=f.plan.paths;
 return {...f.plan,schemaVersion:2,releaseId:'v2',paths:{scripts,runtime,executable,models,
 configFile:'C:\\ProtectedData\\settings\\runtime.json',apiKeyFile:'C:\\ProtectedData\\secrets\\backend.key',
 logsDirectory:'C:\\ProtectedData\\logs',stateDirectory:'C:\\ProtectedData\\state',evidenceDirectory:'C:\\ProtectedData\\evidence'}};
}
function resourceEvidence(r){return {...r,nativeVerified:true,nodeWriteDenied:true,ancestorsVerified:true,reparsePoint:false,replaceable:false,unauthorizedReadDenied:true};}
for(const [name,change] of [
 ['suffix',s=>s.replace('watchdog-recovery.pending\'','watchdog-recovery.pending.old\'')],
 ['alternate',s=>s.replace('watchdog-recovery.pending','other.pending')],
 ['comment-only',s=>s.replace('    $marker =','    # $marker =')],
 ['missing',s=>s.replace(/^    \$marker = .*\r?\n/m,'')],
 ['duplicate',s=>s.replace('    $timer =',"    $marker = 'C:\\AI\\logs\\watchdog-recovery.pending'\n    $timer =")],
 ['conflicting',s=>s.replace('    $timer =',"    $marker = 'C:\\Other\\marker'\n    $timer =")],
 ['block-comment',s=>'<#\n'+s+'\n#>'],
 ['unrelated-string',s=>"$unrelated = @'\n"+s+"\n'@"],
 ['changed-reference',s=>s.replace('[IO.File]::Delete($marker)','[IO.File]::Delete($other)')]
]) test('v2 marker rejects '+name,t=>{
 const f=fixture(t),p=v2plan(f),src=p.sources['chatbot-watchdog.ps1'];
 fs.writeFileSync(src.path,change(fs.readFileSync(src.path,'utf8')));src.sha256=hash(fs.readFileSync(src.path));
 assert.throws(()=>build(p,f.dir),/marker-source-unrecognized/);assert(!fs.existsSync(path.join(f.dir,'v2')));
});
test('marker strictness is v2 only; v1 manifest remains v1',t=>{
 const f=fixture(t);assert.equal(JSON.parse(fs.readFileSync(path.join(f.built.root,'manifest.json'))).schemaVersion,1);
 f.plan.releaseId='legacy';const src=f.plan.sources['chatbot-watchdog.ps1'];
 fs.appendFileSync(src.path,'\n# legacy comment\n');src.sha256=hash(fs.readFileSync(src.path));
 const b=build(f.plan,f.dir);assert(validate(b.root,b.manifestSha256,f.providers).valid);
});
test('v2 isolates every staged resource consumer and preserves source bytes',t=>{
 const f=fixture(t),p=v2plan(f),before=Object.values(p.sources).map(s=>hash(fs.readFileSync(s.path)));
 const b=build(p,f.dir),m=JSON.parse(fs.readFileSync(path.join(b.root,'manifest.json')));
 assert.equal(m.schemaVersion,2);assert.deepEqual(m.paths,p.paths);
 const read=n=>fs.readFileSync(path.join(b.root,n),'utf8');
 for(const n of ['chatbot-watchdog.ps1','Restart-ChatbotAI.ps1','Test-ChatbotLiveBackendOwnership.ps1','start-chatbot-ai.ps1'])assert(read(n).includes(p.paths.configFile));
 for(const n of ['chatbot-watchdog.ps1','Restart-ChatbotAI.ps1','chatbot-backend-evidence.ps1','start-chatbot-ai.ps1'])assert(read(n).includes(p.paths.apiKeyFile));
 assert(read('chatbot-owned-backend.ps1').includes(p.paths.apiKeyFile.toLowerCase()));
 const w=read('chatbot-watchdog.ps1');assert(w.includes(p.paths.stateDirectory+'\\watchdog-recovery.pending'));assert(w.includes(p.paths.logsDirectory+'\\watchdog.log'));assert(w.includes('[IO.FileMode]::CreateNew'));assert(w.includes('[IO.File]::Delete($marker)'));
 for(const n of FILES){const text=read(n);assert(!/C:\\AI\\|Downloads\\|config\\llama-api-key|logs\\watchdog-recovery/.test(text));assert.equal(hash(text),m.files.find(x=>x.path===n).sha256);}
 assert.deepEqual(Object.values(p.sources).map(s=>hash(fs.readFileSync(s.path))),before);
 assert.equal(fs.readdirSync(b.root).length,8);assert.equal(validate(b.root,b.manifestSha256).reason,'security-unverified');
 assert.equal(validate(b.root,b.manifestSha256,{...f.providers,inspectResourceSecurity:resourceEvidence}).valid,true);
});
test('v1 and v2 are explicitly isolated, including missing and legacy fields',t=>{
 const f=fixture(t);assert(f.check().valid);
 const p=v2plan(f);delete p.schemaVersion;assert.throws(()=>build(p,f.dir),/invalid-profile/);
 p.schemaVersion=2;p.paths.config='C:\\Other';assert.throws(()=>build(p,f.dir),/invalid-profile/);
 delete p.paths.config;delete p.paths.apiKeyFile;assert.throws(()=>build(p,f.dir),/invalid-profile/);
 f.mutate(m=>m.schemaVersion=2);assert.equal(f.check().reason,'invalid-profile');
});
test('v2 rejects overlap, file-directory collision, traversal and unsafe paths',t=>{
 const f=fixture(t);
 for(const patch of [p=>p.apiKeyFile=p.configFile,p=>p.stateDirectory=p.logsDirectory,p=>p.evidenceDirectory=p.scripts+'\\reports',p=>p.configFile=p.stateDirectory,p=>p.configFile='C:\\Data\\..\\x',p=>p.apiKeyFile='C:\\Data\\NUL',p=>p.logsDirectory='C:\\Data\\*']){
 const p=v2plan(f);patch(p.paths);assert.throws(()=>build(p,f.dir));assert(!fs.existsSync(path.join(f.dir,'v2')));
 }
});
test('v2 rejects ambiguous file suffix and unmapped configuration directory',t=>{
 const f=fixture(t),p=v2plan(f),src=p.sources['start-chatbot-ai.ps1'];
 fs.appendFileSync(src.path,"\n$unexpected='C:\\AI\\config\\llama-api-key.txt.other'\n");src.sha256=hash(fs.readFileSync(src.path));
 assert.throws(()=>build(p,f.dir),/unmapped-legacy-path/);
});
test('v2 security evidence must attest exact role, type, SYSTEM rights and secret confidentiality',t=>{
 const f=fixture(t),p=v2plan(f),b=build(p,f.dir);
 assert.equal(validate(b.root,b.manifestSha256,f.providers).reason,'security-unverified');
 for(const field of ['nativeVerified','nodeWriteDenied','ancestorsVerified','systemAccess','kind','role','unauthorizedReadDenied','reparsePoint','replaceable']){
 const inspectResourceSecurity=r=>{const e=resourceEvidence(r);if(r.role==='apiKeyFile')delete e[field];return e;};
 assert.equal(validate(b.root,b.manifestSha256,{...f.providers,inspectResourceSecurity}).reason,'security-unverified',field);
 }
});
test('v2 GPU enumeration and staged parsing remain compatible',{skip:process.platform!=='win32'||process.env.CHATBOT_RELEASE_PARSE_ONLY==='1'},t=>{
 const f=fixture(t),b=build(v2plan(f),f.dir);
 const r=require('node:child_process').spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
 ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'staged-gpu-enumeration.ps1'),'-Release',b.root],{timeout:10000,windowsHide:true,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/PASS: 16/);
});
test('v2 missing resource consumer fails closed',t=>{
 const f=fixture(t),p=v2plan(f),s=p.sources['chatbot-owned-backend.ps1'];
 fs.writeFileSync(s.path,fs.readFileSync(s.path,'utf8').replaceAll('c:\\ai\\config\\llama-api-key.txt','C:\\Unexpected\\key'));
 s.sha256=hash(fs.readFileSync(s.path));assert.throws(()=>build(p,f.dir),/resource-source-changed/);
});
test('v2 lifecycle ownership and recovery behavior remain compatible',{skip:process.platform!=='win32'||process.env.CHATBOT_RELEASE_PARSE_ONLY==='1'},t=>{
 const f=fixture(t),p=v2plan(f),b=build(p,f.dir),dir=path.join(f.dir,'test');fs.mkdirSync(dir);
 const maps=[['C:\\AI\\config\\llama-api-key.txt',p.paths.apiKeyFile],['C:\\AI\\config\\chatbot-ai-config.json',p.paths.configFile],
 ['C:\\Users\\Admin\\Downloads\\Chatbot-upgrade-17E2-20261015\\llama-b11609-cuda12.4\\llama-server.exe',p.paths.executable],
 ['C:\\AI\\llama.cpp\\llama-server.exe',p.paths.executable],['C:\\AI\\scripts',p.paths.scripts],['C:\\AI\\models',p.paths.models]];
 for(const n of ['restart-lifecycle-safety.ps1','watchdog-lifecycle.ps1']){
 let text=fs.readFileSync(path.join(__dirname,n),'utf8');for(const [a,z] of maps)text=text.replaceAll(a,z);
 text=text.replaceAll('..\\scripts\\','..\\v2\\');fs.writeFileSync(path.join(dir,n),text);
 }
 const r=require('node:child_process').spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
 ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dir,'watchdog-lifecycle.ps1')],{timeout:15000,windowsHide:true,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/PASS: 58 watchdog assertions/);
});
