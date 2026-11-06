'use strict';
function installAdminRestart({document,fetch,confirm,notifications}) {
    const button=document.getElementById('restartAiServer');
    const status=document.getElementById('aiRestartStatus');
    let pending=false;
    function notify(severity,title,message) {
        try {
            const center=notifications===undefined?globalThis.ChatbotNotifications:notifications;
            if(center) center.show({severity,title,message});
        } catch {
            console.warn('Could not display restart notification.');
        }
    }
    button.addEventListener('click',async()=>{
        if(pending)return;
        if(!(await confirm('Restart llama.cpp using saved settings? Active AI requests will be interrupted. Unsaved changes will not be applied. Node.js and the Admin Console will remain running.')))return;
        if(pending)return;
        pending=true;button.disabled=true;status.textContent='Checking restart authorization and managed ownership...';
        try {
            const response=await fetch('/api/admin/ai/restart',{
                method:'POST',credentials:'same-origin',cache:'no-store',
                headers:{'X-Chatbot-Action':'restart-ai'},signal:AbortSignal.timeout(10000)
            });
            const result=await response.json();
            if(result.code==='LIFECYCLE_ACTIVATION_DISABLED'||result.ownership==='unverified') {
                status.textContent='Ownership unknown. In-app restart is unavailable because no qualified lifecycle owner is connected. Save your configuration, then run Restart-ChatbotAI from an elevated PowerShell to apply changes.';
                notify('warning','Restart unavailable','No qualified lifecycle owner is connected. Use the documented elevated restart procedure.');
            } else if(!response.ok) {
                status.textContent='Failed: restart request was rejected. No successful restart has been verified.';
                notify('error','Restart rejected','The restart request was rejected. No successful restart has been verified.');
            } else {
                // Command acceptance alone is never readiness/configuration evidence.
                status.textContent='Restart outcome unverified. Do not retry until the backend state is checked.';
                notify('warning','Restart outcome unverified','The request was accepted, but a successful restart has not been verified. Check backend state before retrying.');
                return;
            }
        } catch {
            status.textContent='Restart outcome unknown: communication failed. Check backend state before trying again.';
            notify('warning','Restart outcome unknown','Communication failed. Check backend state before trying again.');
            return;
        } finally {
            // Keep uncertain operations blocked; reload only after operator review.
            if(status.textContent.startsWith('Ownership unknown.')||status.textContent.startsWith('Failed:')) {
                pending=false;button.disabled=false;
            }
        }
    });
}
if(typeof module!=='undefined'&&module.exports)module.exports={installAdminRestart};
else installAdminRestart({document,fetch:window.fetch.bind(window),confirm:(message)=>window.terminalConfirm?window.terminalConfirm(message,'RESTART AI SERVER'):window.confirm(message)});
