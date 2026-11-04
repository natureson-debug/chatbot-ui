'use strict';
globalThis.AdminProviderUI={
 select(provider,auth){
  document.querySelectorAll('[data-provider-safeguards]').forEach(panel=>{panel.hidden=panel.dataset.providerSafeguards!==provider;});
  const key=document.getElementById('providerProtectedKey');if(key)key.hidden=provider!=='deepseek';
  const option=document.querySelector('#providerAuthMode option[value="protected"]');if(option){option.hidden=provider!=='deepseek';option.disabled=provider!=='deepseek';}
  document.querySelectorAll('[data-provider-safeguards="deepseek"]').forEach(panel=>{panel.dataset.credentialMode=auth==='protected'?'protected':'environment';});
 },
 testResult(data){
  const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?String(value):'N/A';
  const model=typeof data.model==='string'?data.model.slice(0,512):'N/A';
  return [data.success===true?'Connection test succeeded.':'Connection test failed.',
   'Model: '+model,'HTTP status: '+number(data.httpStatus),'Response time: '+number(data.responseTimeMs)+' ms',
   'Input tokens: '+number(data.usage?.promptTokens)+' | Output tokens: '+number(data.usage?.generatedTokens),
   ...(data.success===true?[]:['Check the saved credential, approved model and safeguards before retrying.'])].join('\n');
 }
};
