'use strict';
// Generates a disabled definition only. Never registers tasks or handles passwords.
function bootTask({sid,node,supervisor,cwd,delaySeconds=30}){
 const path=require('node:path');
 if(!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(sid||''))throw Error('DEDICATED_ACCOUNT_REQUIRED');
 for(const p of [node,supervisor,cwd])if(typeof p!=='string'||!path.win32.isAbsolute(p)||p.startsWith('\\\\')||/["\r\n]/.test(p))throw Error('LOCAL_ABSOLUTE_PATH_REQUIRED');
 if(!Number.isSafeInteger(delaySeconds)||delaySeconds<0||delaySeconds>600)throw Error('INVALID_DELAY');
 const x=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>DISABLED qualification candidate; requires separately approved batch account and deployment.</Description></RegistrationInfo>
<Triggers><BootTrigger><Enabled>true</Enabled><Delay>PT${delaySeconds}S</Delay></BootTrigger></Triggers>
<Principals><Principal id="BackendOperator"><UserId>${sid}</UserId><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>false</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="BackendOperator"><Exec><Command>${x(node)}</Command><Arguments>&quot;${x(supervisor)}&quot; --run</Arguments><WorkingDirectory>${x(cwd)}</WorkingDirectory></Exec></Actions>
</Task>`;
}
module.exports={bootTask};
