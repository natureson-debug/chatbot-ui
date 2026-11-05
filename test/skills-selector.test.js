'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createExtensionChoices}=require('../public/extensions');
class Element {
 constructor(){this.children=[];this.events={};this.checked=false;this.disabled=false;}
 append(...items){this.children.push(...items)} replaceChildren(){this.children=[]} addEventListener(n,fn){this.events[n]=fn} focus(){this.focused=true}
 set innerHTML(_){throw Error('Unsafe HTML')}
}
function fixture(){const nodes=Object.fromEntries(['activeSkills','useTools','clearSkills','skillsStatus'].map(id=>[id,new Element()]));let catalog=['one','two','three','four'].map(id=>({id,name:id}));const document={getElementById:id=>nodes[id],createElement:()=>new Element()};const api=createExtensionChoices({document,fetch:async()=>({ok:true,json:async()=>({skills:catalog,toolsAvailable:true})})});return {api,nodes,document,setCatalog:v=>catalog=v,box:i=>nodes.activeSkills.children[i].children[0]};}
test('zero to three selections, independent deselection, limit and clear preserve tools',async()=>{
 const f=fixture();await f.api.load({tools:true});f.nodes.useTools.checked=true;
 assert.deepEqual(f.api.read(),{skillIds:[],useTools:true});
 for(let i=0;i<3;i++){f.box(i).checked=true;f.box(i).events.change();assert.equal(f.api.read().skillIds.length,i+1);}
 assert(f.box(3).disabled);f.box(3).checked=true;f.box(3).events.change();assert.equal(f.api.read().skillIds.length,3);assert(!f.box(3).checked);
 f.box(1).checked=false;f.box(1).events.change();assert.deepEqual(f.api.read().skillIds,['one','three']);assert(!f.box(3).disabled);
 f.nodes.clearSkills.events.click();assert.deepEqual(f.api.read(),{skillIds:[],useTools:true});assert(f.nodes.clearSkills.disabled);
});
test('drawer visibility and catalog refresh preserve only authorized selections and focus',async()=>{
 const f=fixture();await f.api.load({tools:true});f.box(0).checked=true;f.box(0).events.change();f.box(1).checked=true;f.box(1).events.change();
 f.nodes.activeSkills.hidden=true;f.nodes.activeSkills.hidden=false;assert.deepEqual(f.api.read().skillIds,['one','two']);
 f.document.activeElement=f.box(0);f.setCatalog([{id:'one',name:'<img onerror=bad>'},{id:'three',name:'Three'}]);await f.api.load({tools:false});
 assert.deepEqual(f.api.read().skillIds,['one']);assert(f.box(0).focused);assert.equal(f.nodes.activeSkills.children[0].children[1].textContent,'<img onerror=bad>');assert(f.nodes.useTools.disabled);
 f.setCatalog([]);await f.api.load({tools:true});assert.deepEqual(f.api.read().skillIds,[]);
});
test('stale catalog responses cannot restore removed skills; failure clears unavailable selections',async()=>{
 const nodes=Object.fromEntries(['activeSkills','useTools','clearSkills','skillsStatus'].map(id=>[id,new Element()]));const pending=[];
 const api=createExtensionChoices({document:{getElementById:id=>nodes[id],createElement:()=>new Element()},fetch:()=>new Promise(resolve=>pending.push(resolve))});
 const first=api.load({tools:true}),second=api.load({tools:true});pending[1]({ok:true,json:async()=>({skills:[],toolsAvailable:false})});await second;pending[0]({ok:true,json:async()=>({skills:[{id:'stale',name:'Stale'}],toolsAvailable:true})});await first;assert.equal(nodes.activeSkills.children.length,0);
 const failed=api.load({tools:true});pending[2]({ok:false});await failed;assert.deepEqual(api.read(),{skillIds:[],useTools:false});
});
test('native checkbox semantics, labelled grouping and theme tokens remain present',()=>{
 const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/style.css','utf8'),js=fs.readFileSync('public/extensions.js','utf8');
 assert.match(html,/<legend>Active skills \(select up to 3\)<\/legend>/);assert.match(html,/id="skillsStatus" role="status" aria-live="polite"/);assert.match(html,/id="clearSkills" type="button"/);
 assert.match(js,/box.type='checkbox'/);assert.match(js,/label.append\(box,name\)/);assert.match(css,/skill-choice:focus-within/);assert.match(css,/accent-color: var\(--theme-accent\)/);assert.doesNotMatch(html,/<select[^>]*id="activeSkills"/);
});
