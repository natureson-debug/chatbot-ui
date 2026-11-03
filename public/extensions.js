'use strict';
window.readExtensionSelection=()=>({skillIds:Array.from(document.getElementById('activeSkills').selectedOptions).map(o=>o.value),useTools:document.getElementById('useTools').checked});
window.loadExtensionChoices=async capabilities=>{
 const select=document.getElementById('activeSkills'),tools=document.getElementById('useTools');
 try{const r=await fetch('/api/extensions',{cache:'no-store'});if(!r.ok)throw Error();const data=await r.json();select.replaceChildren();for(const s of data.skills){const option=document.createElement('option');option.value=s.id;option.textContent=s.name;select.append(option);}tools.disabled=!data.toolsAvailable||!capabilities?.tools;if(tools.disabled)tools.checked=false;}catch{select.replaceChildren();tools.checked=false;tools.disabled=true;}
};
