'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(){
 class Element{constructor(text='',value=''){this.textContent=text;this.value=value;this.children=[];}appendChild(x){this.children.push(x);}replaceChildren(...xs){this.children=xs;}get options(){return this.children.flatMap(x=>x instanceof Option?[x]:x.children);}get selectedOptions(){return this.options.filter(o=>o.value===this.value);}addEventListener(_,f){this.change=f;}}
 class Option extends Element{}
 const select=new Element(),status=new Element();let saved=0;
 const c={Option,document:{getElementById:id=>id==='chatModelSelect'?select:status,createElement:()=>new Element()},saveUserSettings(){saved++;},fetch:async()=>({ok:true,json:async()=>({defaultId:'p',models:[{providerId:'p',providerName:'Provider',model:'alias',name:'Friendly',contextLimit:null,capabilities:{streaming:true}}]})})};vm.createContext(c);vm.runInContext(fs.readFileSync('public/model-selector.js','utf8'),c);return{c,select,status,saves:()=>saved};
}
test('selector groups, restores saved pair and persists changes through existing settings callback',async()=>{
 const h=setup();await h.c.chatModelSelector.load({providerId:'p',model:'alias'});assert.equal(h.select.children[1].label,'Provider');assert.equal(h.c.chatModelSelector.capture().model,'alias');assert.equal(h.c.chatModelSelector.runtime().modelName,'alias');h.select.change();assert.equal(h.saves(),1);assert(h.status.textContent.includes('Existing history'));
});
test('unavailable saved choice is retained, never silently switched',async()=>{const h=setup();await h.c.chatModelSelector.load({providerId:'removed',model:'old'});assert.equal(h.c.chatModelSelector.capture().providerId,'removed');assert(h.status.textContent.includes('unavailable'));});
test('session replacement invalidates pending selector load',async()=>{const h=setup();let release;h.c.fetch=()=>new Promise(r=>release=r);const pending=h.c.chatModelSelector.load(null);h.c.chatModelSelector.reset();release({ok:true,json:async()=>({models:[]})});await pending;assert.equal(h.select.disabled,true);assert.equal(h.select.options.length,1);});
test('default label uses authoritative model pair when it is not first in catalog',async()=>{const h=setup();h.c.fetch=async()=>({ok:true,json:async()=>({defaultId:'p',default:{providerId:'p',model:'second'},models:[{providerId:'p',providerName:'Provider',model:'first',name:'First',contextLimit:null,capabilities:{streaming:true}},{providerId:'p',providerName:'Provider',model:'second',name:'Second',contextLimit:null,capabilities:{streaming:true}}]})});await h.c.chatModelSelector.load(null);assert.equal(h.select.children[0].textContent,'Default: Provider / second');});
