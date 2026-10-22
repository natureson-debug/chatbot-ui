const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync('public/app.js','utf8');
const add=source.slice(source.indexOf('function addMessage('),source.indexOf('function updateDeleteChatButtonState('));
const send=source.slice(source.indexOf('async function readAssistantStream('),source.indexOf('sendButton.addEventListener('));
const toggle=source.slice(source.indexOf('thinkingToggle.addEventListener("change",'),source.indexOf('settingsToggle.addEventListener("click",'));
class El {constructor(tag='div'){this.tag=tag;this.children=[];this.hidden=false;this.checked=false;this.value='';this.textContent='';this.open=false;this.className='';this.classList={add(){},remove(){}};}appendChild(x){if(x.parent)x.parent.children=x.parent.children.filter(y=>y!==x);this.children.push(x);x.parent=this} set innerHTML(x){this.html=x;if(x==='')this.children=[]}get innerHTML(){return this.html||''}focus(){}remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this)}setAttribute(){}querySelector(c){return this.querySelectorAll(c)[0]}querySelectorAll(c){let a=[];for(const x of this.children){if(x.className===c.slice(1))a.push(x);a.push(...x.querySelectorAll(c))}return a}addEventListener(t,f){this[t]=f}}
const {test}=require('node:test');
const slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const response=(data,status=200,rev=0)=>({ok:status<400,status,headers:{get:()=>rev===null?null:String(rev)},json:async()=>data});
const delta=x=>'data: '+JSON.stringify({choices:[{delta:x}]})+'\n\n';
const done='data: [DONE]\n\n';
function setup(){
 const c={console:{log(){},error(){}},TextDecoder,AbortController,sessionEpoch:0,nextGenerationId:0,historyLoadSequence:0,
 chatStore:{activeChatId:'A',chats:{A:{title:'A',messages:[],serverRevision:3},B:{title:'B',messages:[],serverRevision:9}}},
 loginScreen:{hidden:true},generating:false,activeGeneration:null,assistantViews:new WeakMap(),controller:null,contextLimit:32768,
 document:{createElement:t=>new El(t),querySelectorAll:()=>[]},readSelectedAttachment:async()=>null,renderChatList(){},
 loadAiRuntime:async()=>{},saveUserSettings(){},marked:{parse:x=>x},DOMPurify:{sanitize:x=>x},confirm:()=>true,alert(){},
 updateActiveChatTitle(){},updateDeleteChatButtonState(){}};
 for(const name of ['chat','promptBox','sendButton','stopButton','attachmentInput','attachmentName','removeAttachmentButton','systemPromptBox','temperatureInput','maxTokensInput','statusText','thinkingToggle','newChatButton','deleteChatButton'])c[name]=new El();
 c.promptBox.value='hello';c.temperatureInput.value='.7';c.maxTokensInput.value='32';c.messages=c.chatStore.chats.A.messages;
 const calls=[];let inference=0;const fixtures=[delta({reasoning_content:'private'}),delta({content:'answer'}),done];
 c.fetch=async(url,opt={})=>{
  const body=opt.body?JSON.parse(opt.body):null;calls.push({url,opt,body});
  if(c.intercept){const result=await c.intercept(url,opt,body);if(result!==undefined)return result;}
  if(url==='/api/chat'){inference++;let i=0;return{ok:true,body:{getReader:()=>({read:async()=>{if(c.streamHook)await c.streamHook(i);if(i===fixtures.length)return{done:true};const f=fixtures[i++];if(f instanceof Error)throw f;return{value:Buffer.from(f),done:false}},cancel:async()=>{},releaseLock(){}})}};}
  if(url==='/api/chats')return opt.method==='POST'?response({id:'C',title:'C',revision:0},201):response([{id:'A',title:'A',revision:3}]);
  if(opt.method==='DELETE')return response({deletedMessages:1,revision:4});
  if(opt.method==='POST')return response({id:'1'},201);
  return response([],200,4);
 };
 vm.createContext(c);vm.runInContext(slice('function requireServerRevision(','const assistantViews =')+slice('function generationIsValid(','let controller =')+add+send+toggle+
 slice('newChatButton.addEventListener(','stopButton.addEventListener(')+slice('async function fetchServerChats(','async function inspectServerChats('),c);
 return {c,calls,fixtures,inferences:()=>inference,saves:()=>calls.filter(x=>x.body?.role)};
}
test('new chat gets revision zero',async()=>{const {c}=setup();await c.newChatButton.click();assert.equal(c.chatStore.chats.C.serverRevision,0)});
test('existing history uses snapshot revision instead of earlier list revision',async()=>{const {c}=setup();const p=await c.prepareServerChatStore();assert.equal(p.chats.A.serverRevision,4)});
test('missing/invalid list and snapshot revisions rejected',async()=>{for(const rev of [null,'',-1,'x',9007199254740992]){const {c}=setup();c.intercept=(url)=>url.endsWith('/messages')?response([],200,rev):undefined;await assert.rejects(c.prepareServerChatStore())}const {c}=setup();c.intercept=()=>response([{id:'A',title:'A'}]);await assert.rejects(c.prepareServerChatStore())});
test('both saves capture immutable revision; background state cannot change it',async()=>{const h=setup();h.c.streamHook=()=>{h.c.chatStore.chats.A.serverRevision=8;h.c.chatStore.activeChatId='B';h.c.messages=h.c.chatStore.chats.B.messages;h.c.restoreChat();};await h.c.sendMessage();assert.deepEqual(h.saves().map(x=>x.body.expectedRevision),[3,3]);assert.equal(h.c.chatStore.chats.B.messages.length,0);assert.equal(h.c.chat.children.length,0)});
test('clear adopts increment then next generation uses it',async()=>{const h=setup();await h.c.clearConversation('A');assert.equal(h.c.chatStore.chats.A.serverRevision,4);await h.c.sendMessage();assert.deepEqual(h.saves().map(x=>x.body.expectedRevision),[4,4])});
test('user conflict prevents inference and assistant save, no retry',async()=>{const h=setup();h.c.intercept=(u,o,b)=>b?.role==='user'?response({},409):undefined;await h.c.sendMessage();assert.equal(h.inferences(),0);assert.equal(h.saves().length,1);assert.equal(h.c.chatStore.chats.A.messages.length,0);assert.equal(h.c.generating,false)});
test('assistant conflict removes rejected output and does not retry',async()=>{const h=setup();h.c.intercept=(u,o,b)=>b?.role==='assistant'?response({},409):undefined;await h.c.sendMessage();assert.equal(h.saves().length,2);assert.equal(h.c.chatStore.chats.A.messages.length,0);assert.equal(h.c.chat.children.length,0)});
test('lost clear response reconciles committed revision',async()=>{const h=setup();h.c.intercept=(u,o)=>{if(o.method==='DELETE')throw Error('lost');};await h.c.clearConversation('A');assert.equal(h.c.chatStore.chats.A.serverRevision,4);assert.equal(h.c.chatStore.chats.A.lifecyclePending,false)});
test('failed reconciliation keeps sends blocked',async()=>{const h=setup();h.c.intercept=()=>{throw Error('offline')};await h.c.clearConversation('A');await h.c.sendMessage();assert.equal(h.c.chatStore.chats.A.lifecyclePending,true);assert.equal(h.saves().length,0)});
test('deleted reconciliation removes only origin',async()=>{const h=setup();h.c.chatStore.activeChatId='B';h.c.messages=h.c.chatStore.chats.B.messages;h.c.intercept=()=>response({},404);await h.c.reconcileConversation('A');assert.equal(h.c.chatStore.chats.A,undefined);assert.equal(h.c.chatStore.activeChatId,'B');assert.equal(h.c.messages.length,0)});
test('stale history load rejected after local state change',async()=>{const {c}=setup();c.intercept=(u)=>{if(u.endsWith('/messages'))c.chatStore.chats.A.historyRevision=1;};await assert.rejects(c.prepareServerChatStore(),/state changed/)});
test('newer reconciliation wins over obsolete response',async()=>{const {c}=setup();let release;let first=true;c.intercept=()=>{if(first){first=false;return new Promise(r=>release=r)}return response([{role:'user',content:'new'}],200,6)};const old=c.reconcileConversation('A');await c.reconcileConversation('A');release(response([{role:'user',content:'old'}],200,5));await old;assert.equal(c.chatStore.chats.A.serverRevision,6);assert.equal(c.messages[0].content,'new')});
test('logout/session replacement ignores pending reconciliation',async()=>{const {c}=setup();let release;c.intercept=()=>new Promise(r=>release=r);const p=c.reconcileConversation('A');c.replaceSession();const next={title:'new session',messages:[],serverRevision:9};c.chatStore.chats.A=next;release(response([],200,4));await p;assert.equal(c.chatStore.chats.A,next);assert.equal(next.serverRevision,9)});
test('thinking and token-limit partial content persist once without reasoning or notices',async()=>{const h=setup();h.c.thinkingToggle.checked=true;h.fixtures.splice(2,0,'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}],timings:{predicted_n:2,predicted_per_second:4,predicted_ms:500,prompt_n:3,cache_n:0}})+'\n\n');await h.c.sendMessage();assert.equal(h.saves().length,2);assert.equal(h.saves()[1].body.content,'answer');assert.equal(h.saves()[1].body.telemetry.contextTokens,5);assert(!JSON.stringify(h.saves()).includes('private'));assert(h.c.chat.querySelectorAll('.message-thinking')[0].children[1].textContent.includes('private'))});
test('transport failure and cancellation preserve partial-save-once contract',async()=>{for(const error of [Error('transport'),Object.assign(Error('cancel'),{name:'AbortError'})]){const h=setup();h.fixtures[2]=error;await h.c.sendMessage();assert.equal(h.saves().length,2);assert.equal(h.saves()[1].body.content,'answer')}});
test('unknown revision reconciles without inventing zero or launching inference',async()=>{const h=setup();delete h.c.chatStore.chats.A.serverRevision;await h.c.sendMessage();assert.equal(h.saves().length,0);assert.equal(h.inferences(),0);assert.equal(h.c.chatStore.chats.A.serverRevision,4)});
