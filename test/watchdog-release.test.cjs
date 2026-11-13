'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {FILES,hash,build,validate,selectRollback}=require('../scripts/watchdog-release.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watchdog-offline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const sources={};
 for(const name of FILES){const repo=path.join(__dirname,'..','scripts',name);
 const text=fs.existsSync(repo)?fs.readFileSync(repo,'utf8'):name==='chatbot-lifecycle-lock.ps1'?"# fixture\n$identity='Global\\Chatbot.LlamaLifecycle'\n":"# harmless launcher fixture\n$output = @(& $ServerExe --list-devices 2>&1)\n$LlamaDir='C:\\Users\\Admin\\Downloads\\Chatbot-upgrade-17E2-20261015\\llama-b11609-cuda12.4'\n";
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
test('invalid manifest',t=>{const f=fixture(t);f.mutate(m=>m.schemaVersion=2);assert.equal(f.check().reason,'invalid-manifest');});
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
test('actual staged enumeration guards enforce directory, executable, failures and restoration',{skip:process.platform!=='win32'},t=>{
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
