'use strict';
// A non-sensitive display preference, available before login content is parsed.
(()=>{
 const supported=['dark','light','normal-dark','normal-light'],key='chatbot.theme';
 const normalize=value=>supported.includes(value)?(value==='light'?'normal-light':value):'dark';
 let theme='dark';try{theme=normalize(localStorage.getItem(key));}catch{}
 document.body.dataset.theme=theme;
 globalThis.ChatbotTheme={
  normalize,
  remember(value){try{localStorage.setItem(key,normalize(value));}catch{}}
 };
})();
