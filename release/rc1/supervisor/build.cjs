'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=__dirname;
const {TIMEOUTS}=require('./timeouts.cjs');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function build(profile,out) {
 fs.mkdirSync(out,{recursive:true});
 const w=s=>'L'+JSON.stringify(s);
 if(!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(profile.operatorSid||''))throw Error('OPERATOR_SID_REQUIRED');
 const pins=[profile.executable,...(profile.pinFiles||[])];
 fs.writeFileSync(path.join(out,'profile.h'),[
 '#pragma once','#define OPERATOR_SID '+w(profile.operatorSid),'#include <utility>','#define TEST_PROFILE '+(profile.fixture===true?1:0),
 '#define TARGET_PATH '+w(profile.executable),'#define TARGET_CWD '+w(profile.cwd),
 '#define LEASE_PATH '+w(path.join(out,'child.lease')),
 '#define EXPECTED_PORT '+profile.port,'#define EXPECTED_ADDRESS '+(profile.host==='0.0.0.0'?'INADDR_ANY':'INADDR_LOOPBACK'),
 '#define SHUTDOWN_MS '+(profile.shutdownMs||TIMEOUTS.nativeStopMs),
 'static const std::vector<std::wstring> TARGET_ARGS={'+profile.args.map(w).join(',')+'};',
 'static const std::vector<std::pair<std::wstring,std::string>> PINNED_FILES={'+pins.map(p=>'{'+w(p)+',"'+hash(p)+'"}').join(',')+'};'
 ].join('\n'));
 const target=path.join(out,'broker.exe'),vc='C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat';
 const script=path.join(out,'build.cmd');
 fs.writeFileSync(script,[
 '@echo off','call "'+vc+'" x64 10.0.22621.0','if errorlevel 1 exit /b 1',
 'cl /std:c++17 /EHsc /W4 /utf-8 /MT /D_WIN32_WINNT=0x0A00 /I"'+path.join(root,'src')+'" /I"'+out+'" /Fo"'+out+'\\\\" /Fe"'+target+'" "'+path.join(root,'src','broker.cpp')+'" /link /MACHINE:X64 kernel32.lib advapi32.lib user32.lib bcrypt.lib iphlpapi.lib ws2_32.lib',
 'exit /b %errorlevel%',''].join('\r\n'));
 const r=spawnSync(process.env.ComSpec,['/d','/c',script],{cwd:out,windowsHide:true,encoding:'utf8',timeout:60000});
 fs.writeFileSync(path.join(out,'build.log'),(r.stdout||'')+(r.stderr||''));
 if(r.status!==0)throw Error('BUILD_FAILED '+path.join(out,'build.log'));
 const b=fs.readFileSync(target);if(b.readUInt16LE(b.readUInt32LE(0x3c)+4)!==0x8664)throw Error('NOT_X64');
 fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({broker:hash(target),pins:pins.map(p=>({path:p,sha256:hash(p)})),profile},null,2));
 return target;
}
module.exports={build,hash};
if(require.main===module){
 const profile=require('./profile.json'),spec=require('C:/AI/chatbot-ui/core/llama-launch.js').buildLlamaLaunchSpec(profile.backend);
 const files=JSON.parse(fs.readFileSync('C:/Users/Admin/Downloads/Chatbot-upgrade-17E2-20261015/staged-manifest.json','utf8').replace(/^\uFEFF/,''));
 const backend=build({operatorSid:profile.sid,executable:spec.executable,cwd:spec.cwd,args:spec.args,host:spec.expected.host,port:spec.expected.port,pinFiles:files.map(x=>x.Path).filter(p=>p!==spec.executable)},path.join(root,'build','backend'));
 const sourceRoot='C:/AI/chatbot-ui';
 const modules=fs.readdirSync(path.join(sourceRoot,'core'),{recursive:true}).filter(p=>p.endsWith('.js')).map(p=>path.join(sourceRoot,'core',p));
 const application=build({...profile.application,operatorSid:profile.sid,pinFiles:[...['server.js','db.js','auth.js','package.json'].map(p=>path.join(sourceRoot,p)),...modules]},path.join(root,'build','application'));
 console.log(JSON.stringify({backend,application}));
}
