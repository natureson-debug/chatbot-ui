'use strict';
function createExtensionChoices({document,fetch}) {
 const list=document.getElementById('activeSkills'),tools=document.getElementById('useTools');
 const clear=document.getElementById('clearSkills'),status=document.getElementById('skillsStatus');
 let selected=new Set(),boxes=[],requestId=0;
 function update(){
  for(const box of boxes){box.checked=selected.has(box.value);box.disabled=selected.size>=3&&!box.checked;}
  clear.disabled=selected.size===0;
  status.textContent=boxes.length?`${selected.size} of 3 skills selected.`:'No skills available.';
 }
 clear.addEventListener('click',()=>{selected.clear();update();});
 return {
  read:()=>({skillIds:[...selected],useTools:tools.checked}),
  async load(capabilities){
   const id=++requestId;
   try{
    const r=await fetch('/api/extensions',{cache:'no-store'});if(!r.ok)throw Error();
    const data=await r.json();if(id!==requestId)return;
    if(!Array.isArray(data.skills)||data.skills.some(s=>typeof s.id!=='string'||typeof s.name!=='string'))throw Error();
    const catalog=[...new Map(data.skills.map(s=>[s.id,s])).values()];
    selected=new Set([...selected].filter(value=>catalog.some(s=>s.id===value)));
    const focused=document.activeElement;const focusedId=boxes.includes(focused)?focused.value:null;
    list.replaceChildren();boxes=[];
    for(const skill of catalog){
     const label=document.createElement('label'),box=document.createElement('input'),name=document.createElement('span');
     label.className='skill-choice';box.type='checkbox';box.value=skill.id;name.textContent=skill.name;
     box.addEventListener('change',()=>{if(box.checked){if(selected.size<3)selected.add(skill.id);}else selected.delete(skill.id);update();});
     label.append(box,name);list.append(label);boxes.push(box);
    }
    update();
    if(focusedId){const replacement=boxes.find(b=>b.value===focusedId&&!b.disabled);if(replacement)replacement.focus();else list.focus();}
    tools.disabled=!data.toolsAvailable||!capabilities?.tools;if(tools.disabled)tools.checked=false;
   }catch{
    if(id!==requestId)return;
    selected.clear();boxes=[];list.replaceChildren();update();status.textContent='Skills unavailable. Reload the model settings to try again.';
    tools.checked=false;tools.disabled=true;
   }
  }
 };
}
if(typeof module!=='undefined'&&module.exports)module.exports={createExtensionChoices};
else {
 const choices=createExtensionChoices({document,fetch:window.fetch.bind(window)});
 window.readExtensionSelection=choices.read;
 window.loadExtensionChoices=choices.load;
}
