'use strict';
// Offline only: this module never runs a release, task, or permission command.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const FILES = Object.freeze(['chatbot-watchdog.ps1','chatbot-owned-backend.ps1','chatbot-backend-evidence.ps1','Restart-ChatbotAI.ps1','Test-ChatbotLiveBackendOwnership.ps1','chatbot-lifecycle-lock.ps1','start-chatbot-ai.ps1']);
const OLD = Object.freeze({
  executable:'C:\\Users\\Admin\\Downloads\\Chatbot-upgrade-17E2-20261015\\llama-b11609-cuda12.4\\llama-server.exe',
  runtime:'C:\\Users\\Admin\\Downloads\\Chatbot-upgrade-17E2-20261015\\llama-b11609-cuda12.4',
  scripts:'C:\\AI\\scripts', config:'C:\\AI\\config', models:'C:\\AI\\models', logs:'C:\\AI\\logs'
});
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = code => { throw Object.assign(new Error(code), {code}); };
const exact = (o, ks) => o && typeof o==='object' && !Array.isArray(o) && Object.keys(o).sort().join('|')===ks.slice().sort().join('|');
const digest = s => typeof s==='string' && /^[a-f0-9]{64}$/.test(s);
function winPath(p) {
  if(typeof p!=='string' || !/^[A-Za-z]:\\/.test(p) || /['"`$\r\n\x00]/.test(p) || p.slice(2).includes(':') || p.split('\\').some(s=>s==='..'||s==='.'||/[. ]$/.test(s)) || path.win32.normalize(p)!==p) fail('invalid-reference');
}
function profile(p) {
  if(!exact(p,Object.keys(OLD))) fail('invalid-profile');
  Object.values(p).forEach(winPath);
  if(path.win32.dirname(p.executable)!==p.runtime || path.win32.basename(p.executable)!=='llama-server.exe') fail('invalid-runtime');
  if(new Set(Object.values(p)).size!==Object.keys(p).length) fail('conflicting-paths');
  const dirs=['runtime','scripts','config','models','logs'].map(k=>p[k].toLowerCase());
  if(dirs.some((a,i)=>dirs.some((b,j)=>i!==j && (a===b || a.startsWith(b+'\\'))))) fail('conflicting-paths');
}
function noLinks(p) {
  let current=path.resolve(p);
  for(;;){const s=fs.lstatSync(current);if(s.isSymbolicLink())fail('reparse-point');const next=path.dirname(current);if(next===current)break;current=next;}
}
function secretCheck(s) {
  if(/-----BEGIN .*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.-]{20,}/.test(s)) fail('secret-material');
}
function validatePlan(p) {
  if(!exact(p,['releaseId','sourceCommit','sources','paths','runtimeDependencies']) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(p.releaseId) || !/^[a-f0-9]{40}$/.test(p.sourceCommit)) fail('invalid-plan');
  profile(p.paths);
  if(!exact(p.sources,FILES))fail('invalid-source-list');
  for(const s of Object.values(p.sources))if(!exact(s,['path','sha256'])||!path.isAbsolute(s.path)||!digest(s.sha256))fail('invalid-source');
  dependencies(p.runtimeDependencies,p.paths);
}
function dependencies(ds,p) {
  if(!Array.isArray(ds)||!ds.length||ds.length>128)fail('missing-runtime-dependency');
  const seen=new Set();
  for(const d of ds){if(!exact(d,['path','sha256'])||!digest(d.sha256))fail('invalid-runtime-dependency');winPath(d.path);if(path.win32.dirname(d.path)!==p.runtime||! /\.(exe|dll)$/i.test(d.path)||seen.has(d.path.toLowerCase()))fail('invalid-runtime-dependency');seen.add(d.path.toLowerCase());}
  if(!seen.has(p.executable.toLowerCase()))fail('missing-runtime-dependency');
}
function build(plan, temporaryParent) {
  validatePlan(plan);
  const parent=path.resolve(temporaryParent), temp=path.resolve(os.tmpdir());
  if(!path.isAbsolute(temporaryParent)||!parent.startsWith(temp+path.sep))fail('temporary-destination-required');
  noLinks(parent);
  const root=path.join(parent,plan.releaseId);
  if(fs.existsSync(root))fail('release-exists');
  const output={};
  for(const name of FILES){
    const src=plan.sources[name];noLinks(src.path);const b=fs.readFileSync(src.path);
    if(hash(b)!==src.sha256)fail('source-hash-mismatch');
    let text=b.toString('utf8');secretCheck(text);
    for(const [k,v] of Object.entries(OLD))text=text.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),match=>match===match.toLowerCase()?plan.paths[k].toLowerCase():plan.paths[k]);
    if(/C:\\AI\\|Chatbot-upgrade-17E2/i.test(text))fail('unmapped-legacy-path');
    if(name==='chatbot-lifecycle-lock.ps1' && !text.includes("'Global\\Chatbot.LlamaLifecycle'"))fail('lock-identity-mismatch');
    output[name]=text;
  }
  const manifest={schemaVersion:1,releaseId:plan.releaseId,sourceCommit:plan.sourceCommit,paths:plan.paths,
    entryPoints:{watchdog:'chatbot-watchdog.ps1',launcher:'start-chatbot-ai.ps1'},lockIdentity:'Global\\Chatbot.LlamaLifecycle',
    files:FILES.map(name=>({path:name,sha256:hash(output[name]),sourceSha256:plan.sources[name].sha256})),runtimeDependencies:plan.runtimeDependencies};
  fs.mkdirSync(root); // Existing parent only; a failed build is never qualified.
  for(const [name,text] of Object.entries(output))fs.writeFileSync(path.join(root,name),text,{flag:'wx'});
  fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {root,manifestSha256:hash(fs.readFileSync(path.join(root,'manifest.json'))),deploymentQualified:false};
}
function validate(root, expectedManifestHash, {inspectSecurity,inspectRuntime}={}) {
  try {
    noLinks(root);const bytes=fs.readFileSync(path.join(root,'manifest.json'));
    if(!digest(expectedManifestHash)||hash(bytes)!==expectedManifestHash)fail('manifest-untrusted');
    const m=JSON.parse(bytes);
    if(!exact(m,['schemaVersion','releaseId','sourceCommit','paths','entryPoints','lockIdentity','files','runtimeDependencies'])||m.schemaVersion!==1||! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(m.releaseId)||! /^[a-f0-9]{40}$/.test(m.sourceCommit))fail('invalid-manifest');
    profile(m.paths);dependencies(m.runtimeDependencies,m.paths);
    if(!exact(m.entryPoints,['watchdog','launcher'])||m.entryPoints.watchdog!=='chatbot-watchdog.ps1'||m.entryPoints.launcher!=='start-chatbot-ai.ps1')fail('invalid-entry-point');
    if(m.lockIdentity!=='Global\\Chatbot.LlamaLifecycle')fail('lock-identity-mismatch');
    if(!Array.isArray(m.files)||m.files.length!==FILES.length||new Set(m.files.map(f=>f.path)).size!==FILES.length)fail('invalid-file-list');
    if(fs.readdirSync(root).sort().join('|')!==[...FILES,'manifest.json'].sort().join('|'))fail('unexpected-or-missing-file');
    for(const f of m.files){
      if(!exact(f,['path','sha256','sourceSha256'])||!FILES.includes(f.path)||!digest(f.sha256)||!digest(f.sourceSha256))fail('invalid-file-path');
      const file=path.join(root,f.path);noLinks(file);if(!fs.lstatSync(file).isFile())fail('invalid-file');
      const b=fs.readFileSync(file);if(hash(b)!==f.sha256)fail('file-hash-mismatch');secretCheck(b.toString('utf8'));
      if(f.path==='chatbot-lifecycle-lock.ps1'&&!b.toString().includes("'Global\\Chatbot.LlamaLifecycle'"))fail('lock-identity-mismatch');
    }
    // Trusted injected providers only; never load evidence from the release manifest.
    // No native effective-access claim is made by this offline prototype.
    if(typeof inspectSecurity!=='function'||typeof inspectRuntime!=='function')fail('security-unverified');
    const securityPaths=[path.resolve(root),path.join(path.resolve(root),'manifest.json'),...FILES.map(f=>path.join(path.resolve(root),f)),...Object.values(m.paths),...m.runtimeDependencies.map(d=>d.path)];
    for(const p of securityPaths){const e=inspectSecurity(p);if(!e||e.path!==p||e.ancestorsVerified!==true||e.effectiveAccessVerified!==true)fail('security-unverified');if(e.reparsePoint!==false)fail('reparse-point');if(e.untrustedWrite!==false||e.replaceable!==false)fail('writable-ancestor');}
    for(const d of m.runtimeDependencies){const e=inspectRuntime(d.path);if(!e||e.path!==d.path||e.sha256!==d.sha256||e.regularFile!==true||e.dependenciesComplete!==true)fail('runtime-unverified');}
    return {valid:true,releaseId:m.releaseId,qualification:'injected-evidence-only'};
  } catch(e){return {valid:false,reason:e.code && /^[a-z-]+$/.test(e.code)?e.code:'release-invalid'};}
}
function selectRollback(root,expectedManifestHash,providers){const result=validate(root,expectedManifestHash,providers);if(!result.valid)fail('rollback-unverified');return {root:path.resolve(root),releaseId:result.releaseId};}
module.exports={FILES,OLD,hash,build,validate,selectRollback};
if(require.main===module){
  try {const [action,a,b]=process.argv.slice(2);if(action==='build')console.log(JSON.stringify(build(JSON.parse(fs.readFileSync(a,'utf8')),b)));else if(action==='validate'){const r=validate(a,b);console.log(JSON.stringify(r));if(!r.valid)process.exitCode=1;}else fail('usage-build-plan-temp-or-validate-root-hash');}
  catch(e){console.error(/^[a-z-]+$/.test(e.code||'')?e.code:'offline-release-failed');process.exitCode=1;}
}
