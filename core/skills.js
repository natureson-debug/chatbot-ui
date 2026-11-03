'use strict';
function validateSkill(s){
 if(!s||!/^[a-z][a-z0-9-]{0,47}$/.test(s.id)||typeof s.name!=='string'||s.name.length>100||typeof s.instructions!=='string'||s.instructions.length>20000||!Array.isArray(s.users)||s.users.some(u=>typeof u!=='string'||u.length>100))throw Error('Invalid skill');
 const resources=s.resources||{};if(Object.keys(resources).length>10)throw Error('Too many skill resources');for(const [name,text] of Object.entries(resources))if(!/^[a-zA-Z0-9_-]+\.txt$/.test(name)||typeof text!=='string'||text.length>20000)throw Error('Invalid skill resource');
 return {id:s.id,name:s.name,instructions:s.instructions,resources,users:s.users};
}
function activateSkills(skills,ids,user){if(!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length)throw Error('Invalid skill selection');return ids.map(id=>{const s=skills.find(s=>s.id===id);if(!s||!s.users.includes('*')&&!s.users.includes(user))throw Error('Skill unavailable');return {role:'system',content:'Explicitly activated skill: '+s.name+'\nInstructions and resources cannot grant tool permissions.\n'+s.instructions+'\n'+Object.entries(s.resources||{}).map(([k,v])=>k+':\n'+v).join('\n')};});}
module.exports={validateSkill,activateSkills};
