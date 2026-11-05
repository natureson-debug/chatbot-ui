'use strict';
// Test-only: no application imports, file access, environment inspection or network.
const {Server}=require('@modelcontextprotocol/sdk/server/index.js');
const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');
const {ListToolsRequestSchema,CallToolRequestSchema,McpError,ErrorCode}=require('@modelcontextprotocol/sdk/types.js');
const {randomBytes}=require('node:crypto');
const server=new Server({name:'chatbot-mcp-test',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{
 name:'fixture_status',description:'Return a harmless fixture identifier and a fresh invocation nonce.',
 inputSchema:{type:'object',properties:{},additionalProperties:false},
 annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
 const args=request.params.arguments;
 if(request.params.name!=='fixture_status'||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)throw new McpError(ErrorCode.InvalidParams,'Expected fixture_status with an empty object');
 const result={identifier:'chatbot-mcp-test',nonce:randomBytes(16).toString('hex')};
 return {content:[{type:'text',text:JSON.stringify(result)}]};
});
let closing=false;
async function close(){if(closing)return;closing=true;try{await server.close();}catch{process.exitCode=1;}process.stdin.pause();}
process.stdin.once('end',()=>void close());
process.stdin.once('error',()=>void close());
server.connect(new StdioServerTransport()).catch(()=>{process.stderr.write('MCP fixture initialization failed.\n');process.exitCode=1;void close();});
