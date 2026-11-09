'use strict';

// Native Ollama durations are nanoseconds. Missing/invalid values stay unknown.
function statistics(value) {
 const count = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null;
 const seconds = key => count(key) === null ? null : value[key] / 1e9;
 const generatedTokens = count('eval_count'), generationSeconds = seconds('eval_duration');
 return {
  generatedTokens, generationSeconds,
  generationSpeed: generatedTokens !== null && generationSeconds > 0 ? generatedTokens / generationSeconds : null,
  promptTokens: count('prompt_eval_count'), cachedTokens: count('prompt_eval_cached_count'),
  promptSeconds: seconds('prompt_eval_duration'), totalSeconds: seconds('total_duration'), loadSeconds: seconds('load_duration'),
  contextTokens: null, contextLimit: null
 };
}

function nativeEndpoint(endpoint, resource = 'api/chat') {
 resource = resource || 'api/chat';
 const url = new URL(endpoint);
 // Preserve reverse-proxy prefixes and the configured origin/security boundary.
 url.pathname = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '') + '/' + resource.replace(/^\//, '');
 return url.href;
}

function toSse(response, contextObservation = async()=>({contextUsedTokens:null,contextCapacityTokens:null})) {
 const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal:true}), encoder = new TextEncoder();
 let buffer = '', ended = false, released = false;
 const release = async () => { if (!released) { released = true; try { await reader.cancel(); } finally { reader.releaseLock(); } } };
 async function* events() {
  try {
   while (!ended) {
    const {value, done} = await reader.read();
    buffer += decoder.decode(value, {stream:!done});
    if (buffer.length > 1048576) throw Error();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1 || done && buffer.length) {
     const line = newline === -1 ? buffer : buffer.slice(0,newline);
     buffer = newline === -1 ? '' : buffer.slice(newline+1);
     if (!line.trim()) continue;
     const item = JSON.parse(line);
     if (!item || typeof item.done !== 'boolean' || item.error || (item.message?.content !== undefined && typeof item.message.content !== 'string')) throw Error();
     const chunk = {choices:[{delta:{content:item.message?.content || ''}, finish_reason:item.done ? (item.done_reason || 'stop') : null}]};
     if (item.done) { chunk.telemetry = {...statistics(item),...await contextObservation()}; ended = true; }
     yield encoder.encode('data: '+JSON.stringify(chunk)+'\n\n');
     if (ended) { yield encoder.encode('data: [DONE]\n\n'); break; }
    }
    if (done && !ended) throw Error();
   }
  } catch { throw Error('Provider stream unavailable'); }
  finally { await release(); }
 }
 const iterator = events();
 return new Response(new ReadableStream({
  async pull(controller) { try { const next = await iterator.next(); if(next.done) controller.close(); else controller.enqueue(next.value); } catch { controller.error(Error('Provider stream unavailable')); } },
  async cancel() { await release(); await iterator.return(); }
 }), {headers:{'Content-Type':'text/event-stream'}});
}
module.exports = {statistics, nativeEndpoint, toSse};
