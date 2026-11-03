'use strict';
// A remote connection is never eligible for local GPU/process management.
function connectionPlan(selected, backend) {
 if(!selected)return ['backend','application'];
 if(selected.adapter==='openai-compatible')return ['application'];
 if(selected.adapter!=='llama.cpp'||selected.endpoint!=='http://127.0.0.1:8080/v1'||selected.model!==backend.modelPath)throw Error('LOCAL_CONNECTION_NOT_QUALIFIED');
 return ['backend','application'];
}
module.exports={connectionPlan};
