'use strict';
const {execFile} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const GPU_ARGS = ['--query-gpu=uuid,name,driver_version,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit','--format=csv,noheader,nounits'];
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const positiveInt = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const label = value => typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f]/.test(value) ? value : null;
function parseGpu(text) {
    if(!text.trim())throw Error('GPU_EMPTY');
    return text.trim().split(/\r?\n/).filter(Boolean).slice(0,16).map(line => {
        const fields = line.split(',').map(s=>s.trim());
        if (fields.length !== 9 || !/^GPU-[a-f0-9-]+$/i.test(fields[0])) throw Error('GPU_FORMAT');
        const number = i => fields[i] !== '' && /^[\d.]+$/.test(fields[i]) ? numeric(Number(fields[i])) : null;
        const utilization = number(3);
        return {uuid: fields[0], name: label(fields[1]), driver: label(fields[2]),
            utilizationPercent: utilization !== null && utilization <= 100 ? utilization : null,
            memoryUsedMiB: number(4), memoryTotalMiB: number(5), temperatureC: number(6), powerW: number(7), powerLimitW: number(8)};
    });
}
const METRICS = Object.freeze({
    'llamacpp:prompt_tokens_total':'promptTokensTotal', 'llamacpp:tokens_predicted_total':'generatedTokensTotal',
    'llamacpp:prompt_tokens_seconds':'promptTokensPerSecond', 'llamacpp:predicted_tokens_seconds':'generatedTokensPerSecond',
    'llamacpp:requests_processing':'requestsProcessing', 'llamacpp:requests_deferred':'requestsDeferred'
});
function parseMetrics(text) {
    const result=Object.fromEntries(Object.values(METRICS).map(k=>[k,null]));
    const seen=new Set();
    for(const line of text.split(/\r?\n/)) {
        const sample=line.trim();
        if(!sample||sample.startsWith('#'))continue;
        const match=/^(llamacpp:[a-z_]+)(?:\{[^}]*\})?\s+([^\s]+)(?:\s+\d+)?\s*$/.exec(sample);
        if (!match || !Object.hasOwn(METRICS,match[1])) continue;
        const key=METRICS[match[1]];
        result[key]=seen.has(key)||!/^\+?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(match[2])?null:numeric(Number(match[2]));seen.add(key);
    }
    return result;
}
function readGpu() {
    return new Promise((resolve,reject)=>{
        // Fixed executable and arguments, no shell/PATH lookup or browser-supplied options.
        execFile('C:\\Windows\\System32\\nvidia-smi.exe',GPU_ARGS,
            {windowsHide:true,shell:false,timeout:2500,maxBuffer:32768,encoding:'utf8'},
            (error,stdout)=>error?reject(Error('GPU_UNAVAILABLE')):resolve(stdout));
    });
}
function createTelemetry({request,gpu=readGpu,now=()=>performance.now(),timestamp=()=>new Date().toISOString()}={}) {
    let cached=null,completed=-Infinity,pending=null;
    async function observe(resource) {
        try {
            const r=await request(resource);
            if(r.status===401||r.status===403)return {state:'authentication_failed'};
            if(r.status===404||r.status===501)return {state:'unsupported'};
            if(r.status===503)return {state:'loading_or_unavailable'};
            if(r.status!==200)return {state:'unavailable'};
            return {state:'available',value:resource==='/metrics'?r.text:JSON.parse(r.text)};
        } catch {return {state:'unavailable'};}
    }
    async function collect() {
        const [gpuResult,health,models,props,metrics]=await Promise.all([
            gpu().then(text=>({state:'available',devices:parseGpu(text)})).catch(()=>({state:'unavailable',devices:[]})),
            observe('/health'),observe('/v1/models'),observe('/props'),observe('/metrics')
        ]);
        const modelList=models.value?.data;
        const model=Array.isArray(modelList)&&modelList.length===1?label(modelList[0]?.id):null;
        const runtime=props.value;
        return {sampledAt:timestamp(),pollIntervalMs:5000,gpu:gpuResult,backend:{
            state:health.state==='available'?(health.value?.status==='ok'?'ready':'unavailable'):health.state,
            model,modelState:models.state,contextPerSlot:positiveInt(runtime?.default_generation_settings?.n_ctx),
            parallelSlots:positiveInt(runtime?.total_slots),propertiesState:props.state,
            metricsState:metrics.state,metrics:metrics.state==='available'?parseMetrics(metrics.value):parseMetrics('')
        }};
    }
    return async function sample() {
        if(cached&&now()-completed<5000)return cached;
        if(pending)return pending;
        pending=collect().then(value=>{cached=value;completed=now();return value;}).finally(()=>{pending=null;});
        return pending;
    };
}
let sampler;
function getAdminTelemetry() {
    if(!sampler)sampler=createTelemetry({request:require('./llama-client').readTelemetryResource});
    return sampler();
}
module.exports={getAdminTelemetry,createTelemetry,parseGpu,parseMetrics};
