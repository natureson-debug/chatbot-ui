'use strict';
const {randomUUID}=require('node:crypto');
function forProvider(family='openai'){
 if(!['openai','deepseek'].includes(family))throw Error('Unsupported accounting provider');
 const gate=family==='openai'?'CHATBOT_OPENAI_RESPONSES_ENABLED':'CHATBOT_DEEPSEEK_ENABLED';
 const prepare=(db,sql)=>db.prepare(sql.replaceAll('openai_',family+'_'));
const terminal=new Set(['completed','cancelled','failed','incomplete','interrupted']);
function transaction(db,callback){db.exec('BEGIN IMMEDIATE');try{const result=callback();db.exec('COMMIT');return result;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}}
function denied(code,status=429){const e=Error(code);e.code=code.replaceAll('OPENAI',family.toUpperCase());e.status=status;return e;}
function settings(db){return {...prepare(db,'SELECT * FROM openai_safeguards WHERE id=1').get()};}
function configure(db,value){
 const keys=['enabled','max_output_tokens','max_concurrent','per_hour','per_day','estimated_daily_usd'];
 if(!value||Object.keys(value).some(k=>!keys.includes(k))||typeof value.enabled!=='boolean')throw denied('INVALID_OPENAI_LIMITS',400);
 for(const [key,max] of [['max_output_tokens',32768],['max_concurrent',32],['per_hour',10000],['per_day',100000]])if(!Number.isSafeInteger(value[key])||value[key]<1||value[key]>max)throw denied('INVALID_OPENAI_LIMITS',400);
 if(value.estimated_daily_usd!==null&&(typeof value.estimated_daily_usd!=='number'||!Number.isFinite(value.estimated_daily_usd)||value.estimated_daily_usd<=0))throw denied('INVALID_OPENAI_LIMITS',400);
 return transaction(db,()=>{prepare(db,'UPDATE openai_safeguards SET enabled=?,max_output_tokens=?,max_concurrent=?,per_hour=?,per_day=?,estimated_daily_usd=? WHERE id=1').run(+value.enabled,value.max_output_tokens,value.max_concurrent,value.per_hour,value.per_day,value.estimated_daily_usd);return settings(db);});
}
function admit(db,{provider,userId,chatId,revision,authorize,diagnostic=false,now=Date.now()}){
 if(!diagnostic&&(typeof chatId!=='string'||!Number.isSafeInteger(revision)||revision<0))throw denied('CHAT_CONTEXT_REQUIRED',400);
 if(diagnostic){chatId='';revision=0;}
 if(!provider.parameters?.includes('max_tokens'))throw denied('OPENAI_OUTPUT_LIMIT_UNSUPPORTED',400);
 return transaction(db,()=>{
  if(!authorize())throw denied('SESSION_REVOKED',401);
  if(process.env[gate]!=='1'&&!(family==='deepseek'&&provider.credentialRef==='protected:'+provider.id))throw denied('OPENAI_DISABLED',403);
  const s=settings(db);if(!s.enabled)throw denied('OPENAI_DISABLED',403);
  const chat=prepare(db,'SELECT revision FROM chats WHERE id=? AND user_id=?').get(chatId,userId);
  if(!chat&&!diagnostic)throw denied('CHAT_NOT_FOUND',404);
  if(!diagnostic&&(!Number.isSafeInteger(revision)||revision!==chat.revision))throw denied('CHAT_REVISION_CONFLICT',409);
  // No reliable price/input-cost model is installed. Unknown cost is never zero.
  if(s.estimated_daily_usd!==null)throw denied('OPENAI_COST_UNVERIFIABLE',403);
  if(prepare(db,"SELECT count(*) AS n FROM openai_usage WHERE status='in_progress'").get().n>=s.max_concurrent)throw denied('OPENAI_CONCURRENCY_LIMIT');
  const counts=prepare(db,'SELECT SUM(started_at>?) AS hour, COUNT(*) AS day FROM openai_usage WHERE user_id=? AND started_at>?').get(now-3600000,userId,now-86400000);
  if(counts.hour>=s.per_hour)throw denied('OPENAI_HOURLY_LIMIT');if(counts.day>=s.per_day)throw denied('OPENAI_DAILY_LIMIT');
  const id=randomUUID();prepare(db,"INSERT INTO openai_usage(request_id,provider_id,model_id,user_id,conversation_id,revision,started_at,status) VALUES(?,?,?,?,?,?,?,'in_progress')").run(id,provider.id,provider.model,userId,chatId,revision,now);
  return {id,maxOutput:s.max_output_tokens};
 });
}
function observe(db,id,event,now=Date.now()){
 transaction(db,()=>{
  const row=prepare(db,'SELECT * FROM openai_usage WHERE request_id=?').get(id);
  if(!row||row.status!=='in_progress')return; // terminal writes are idempotent.
  const status=terminal.has(event.status)?event.status:'in_progress';
  const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
  const responseId=typeof event.providerResponseId==='string'&&/^resp_[A-Za-z0-9_-]{1,160}$/.test(event.providerResponseId)?event.providerResponseId:null;
  prepare(db,'UPDATE openai_usage SET status=?,finished_at=?,latency_ms=?,input_tokens=COALESCE(?,input_tokens),output_tokens=COALESCE(?,output_tokens),cached_input_tokens=COALESCE(?,cached_input_tokens),provider_response_id=COALESCE(?,provider_response_id) WHERE request_id=?').run(status,status==='in_progress'?null:now,status==='in_progress'?null:Math.max(0,now-row.started_at),count(event.usage?.promptTokens),count(event.usage?.generatedTokens),count(event.usage?.cachedTokens),responseId,id);
  if(row.conversation_id==='')return; // Administrator diagnostic: never a chat message.
  const chat=prepare(db,'SELECT revision FROM chats WHERE id=? AND user_id=?').get(row.conversation_id,row.user_id);
  if(!chat||chat.revision!==row.revision)return; // Never resurrect cleared/deleted output.
  if(typeof event.text==='string'&&event.text){
   prepare(db,`INSERT OR IGNORE INTO messages(chat_id,role,content,telemetry_json,response_status,response_request_id) VALUES(?,'assistant','',?,?,?)`).run(row.conversation_id,JSON.stringify({provider:event.providerName||row.provider_id,model:row.model_id}),status,id);
   prepare(db,'UPDATE messages SET content=content||? WHERE response_request_id=?').run(event.text,id);
  }
  prepare(db,'UPDATE messages SET response_status=? WHERE response_request_id=?').run(status,id);
  if(event.usage)prepare(db,'UPDATE messages SET telemetry_json=? WHERE response_request_id=?').run(JSON.stringify({provider:event.providerName||row.provider_id,model:row.model_id,...event.usage}),id);
 });
}
function reconcile(db,now=Date.now()){
 return transaction(db,()=>{prepare(db,"UPDATE messages SET response_status='interrupted' WHERE response_request_id IN (SELECT request_id FROM openai_usage WHERE status='in_progress')").run();return prepare(db,"UPDATE openai_usage SET status='interrupted',finished_at=?,latency_ms=MAX(0,?-started_at) WHERE status='in_progress'").run(now,now).changes;});
}
function summary(db,now=Date.now()){
 const today=new Date(now);today.setUTCHours(0,0,0,0);
 return {guiCredentialsAvailable:family==='deepseek',settings:settings(db),environmentEnabled:process.env[gate]==='1',currentConcurrency:prepare(db,"SELECT count(*) AS n FROM openai_usage WHERE status='in_progress'").get().n,
  today:prepare(db,`SELECT count(*) AS requests,COALESCE(SUM(status='completed'),0) AS completed,COALESCE(SUM(status='failed'),0) AS failed,COALESCE(SUM(status='cancelled'),0) AS cancelled,COALESCE(SUM(status='incomplete'),0) AS incomplete,COALESCE(SUM(status='interrupted'),0) AS interrupted,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,COALESCE(SUM(input_tokens IS NULL),0) AS unknownUsage FROM openai_usage WHERE started_at>=?`).get(today.getTime()),estimatedCost:null,costStatus:'unavailable',dayBoundary:'UTC'};
}
return {settings,configure,admit,observe,reconcile,summary,gate};
}
module.exports={...forProvider(),forProvider};
