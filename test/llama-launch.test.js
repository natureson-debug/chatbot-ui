const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildLlamaLaunchSpec } = require('../core/llama-launch');
const stage = 'C:\\Users\\Admin\\Downloads\\Chatbot-upgrade-17E2-20261015\\llama-b11609-cuda12.4';
const qualified = () => ({ platform: 'win32', executable: stage+'\\llama-server.exe', cwd: stage,
    modelPath: 'C:\\AI\\models\\Qwen3-8B-Q5_K_M.gguf', apiKeyFile: 'C:\\AI\\config\\llama-api-key.txt',
    host: '127.0.0.1', port: 8080, corsOrigin: 'http://127.0.0.1:8080', device: 'CUDA0',
    gpuLayers: 37, contextSize: 32768, parallel: 1, verbosity: 4 });
test('qualified profile has exact arguments, expectations and no environment overrides', () => {
    const s=qualified(), r=buildLlamaLaunchSpec(s);
    assert.deepEqual(r.args,['--model',s.modelPath,'--host','127.0.0.1','--port','8080',
        '--api-key-file',s.apiKeyFile,'--cors-origins','http://127.0.0.1:8080',
        '--parallel','1','--ctx-size','32768','--device','CUDA0','--n-gpu-layers','37','--verbosity','4']);
    assert.deepEqual(r.expected,{host:s.host,port:8080,model:s.modelPath,device:'CUDA0',gpuLayers:37,contextSize:32768,parallel:1,verbosity:4});
    assert.equal(r.executable,s.executable); assert.equal(r.cwd,s.cwd); assert.deepEqual(r.env,{});
    assert.equal(r.apiKeyFile,s.apiKeyFile); assert(!r.args.includes('--api-key'));
});
test('explicit construction cannot load filesystem, config, process or runtime modules', () => {
    const source=fs.readFileSync(path.join(__dirname,'../core/llama-launch.js'),'utf8');
    const m={exports:{}};
    vm.runInNewContext(source,{module:m,URL,require(n){
        if(n==='path'||n==='net')return require(n);
        throw Error('Forbidden dependency: '+n);
    }});
    const s=Object.freeze(qualified()); const result=m.exports.buildLlamaLaunchSpec(s);
    assert.equal(result.expected.gpuLayers,37); assert.equal(result.expected.verbosity,4);
});
test('missing/relative paths, invalid values, conflicts and unknown options are rejected', () => {
    const cases=[{executable:undefined},{executable:''},{executable:'llama-server.exe'},{cwd:'C:relative'},
        {modelPath:null},{modelPath:'\\relative.gguf'},{apiKeyFile:'key.txt'}, {modelPath:'C:\\bad\nfile'},
        {platform:'freebsd'},{host:'hostname'},{port:0},{port:65536},{port:'8080'},
        {parallel:0},{parallel:9},{contextSize:32767},{contextSize:Infinity},
        {gpuLayers:-1},{gpuLayers:1.5},{gpuLayers:'37'},{verbosity:-1},{verbosity:'4'},
        {device:'none',gpuLayers:37},{device:'CUDA0,CUDA1'},{device:'--device'},
        {corsOrigin:'http://user:password@localhost'},{corsOrigin:'http://localhost/path'},
        {args:['--host','0.0.0.0']},{env:{PATH:'untrusted'}},{apiKey:'secret'}];
    // A leading dash is not a device identity supported by this API.
    for(const change of cases) assert.throws(()=>buildLlamaLaunchSpec({...qualified(),...change}),JSON.stringify(change));
    for(const value of [null,undefined,[],false])assert.throws(()=>buildLlamaLaunchSpec(value));
});
test('optional flags are omitted, never silently replaced with qualified values', () => {
    const s=qualified(); delete s.gpuLayers;delete s.verbosity;const r=buildLlamaLaunchSpec(s);
    assert(!r.args.includes('--n-gpu-layers'));assert(!r.args.includes('--verbosity'));
    assert.equal(r.expected.gpuLayers,null);assert.equal(r.expected.verbosity,null);
});
test('generic spec supports explicit POSIX paths and non-CUDA device labels without runtime support', () => {
    for(const platform of ['linux','darwin']) {
        const r=buildLlamaLaunchSpec({...qualified(),platform,executable:'/opt/chatbot/llama-server',cwd:'/opt/chatbot',
            modelPath:'/models/test.gguf',apiKeyFile:'/config/key',device:'none',gpuLayers:0});
        assert.equal(r.expected.device,'none');assert.equal(r.expected.gpuLayers,0);
    }
});
test('legacy wrapper preserves exact shape/default arguments and reads fresh config only', () => {
    let model='old.gguf';const reads=[];const m={exports:{}};
    const source=fs.readFileSync(path.join(__dirname,'../core/llama-launch.js'),'utf8');
    vm.runInNewContext(source,{module:m,process:{platform:'win32'},require(n){
        if(n==='path'||n==='net')return require(n);
        if(n==='./config')return{AI_CONFIG_FILE:'config.json',MODELS_DIR:'C:\\models',API_KEY_FILE:'C:\\key',LLAMA_BIND_HOST:'127.0.0.1',LLAMA_PORT:8080,LLAMA_CORS_ORIGIN:'http://127.0.0.1:8080',LLAMA_DEVICE:'CUDA0'};
        if(n==='./paths')return{LLAMA_EXECUTABLE:'C:\\legacy\\llama-server.exe',LLAMA_CWD:'C:\\legacy'};
        if(n==='fs')return{readFileSync(p){assert.equal(p,'config.json');reads.push(p);return JSON.stringify({model,parallel:1,contextSize:32768})},readdirSync(){return['old.gguf','new.gguf']}};
        throw Error('Forbidden dependency '+n);
    }});
    let r=m.exports.buildLlamaLaunchSpec();assert.deepEqual(Object.keys(r),['executable','cwd','args']);
    assert.equal(r.executable,'C:\\legacy\\llama-server.exe');assert.equal(r.args[1],'C:\\models\\old.gguf');
    assert(!r.args.includes('--verbosity'));assert(!r.args.includes('--n-gpu-layers'));
    model='new.gguf';r=m.exports.buildLlamaLaunchSpec();assert.equal(r.args[1],'C:\\models\\new.gguf');assert.equal(reads.length,2);
    model='missing.gguf';assert.throws(()=>m.exports.buildLlamaLaunchSpec(),/Invalid AI model/);
});
