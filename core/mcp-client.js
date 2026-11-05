'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

function createMcpClient({
    ClientImpl = Client,
    StreamableHTTPTransport = StreamableHTTPClientTransport,
    StdioTransport = StdioClientTransport
} = {}) {
    function reportFailure(onFailure, stage, errorCategory) {
        try { onFailure?.(stage, errorCategory); } catch {}
    }

    async function withMcp(config, action, { signal, onFailure } = {}) {
        const client = new ClientImpl({ name: 'Chatbot', version: '1.0.0' }, { capabilities: {} });
        const bounded = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000);
        let transport;
        let stage = 'connection';
        let failureReported = false;
        const fail = (failureStage, category) => {
            if (failureReported) return;
            failureReported = true;
            reportFailure(onFailure, failureStage, category);
        };

        try {
            if (config.transport === 'stdio') {
                if (typeof config.command !== 'string' || !config.command.trim() ||
                    /[\x00-\x1f\x7f]/.test(config.command) || !Array.isArray(config.args)) {
                    fail('process_launch', 'process_unavailable');
                    throw Error('MCP operation unavailable');
                }
                stage = 'process_launch';
                transport = new StdioTransport({
                    command: config.command,
                    args: config.args,
                    stderr: 'ignore'
                });
            } else {
                let url;
                try { url = new URL(config.url); } catch {
                    fail('connection', 'mcp_connection_failed');
                    throw Error('MCP operation unavailable');
                }
                if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
                    fail('connection', 'mcp_connection_failed');
                    throw Error('MCP operation unavailable');
                }
                const headers = {};
                if (config.credentialRef) {
                    if (!/^env:CHATBOT_[A-Z0-9_]+$/.test(config.credentialRef)) {
                        fail('connection', 'mcp_connection_failed');
                        throw Error('MCP operation unavailable');
                    }
                    const key = process.env[config.credentialRef.slice(4)];
                    if (!key) {
                        fail('connection', 'mcp_connection_failed');
                        throw Error('MCP operation unavailable');
                    }
                    headers.Authorization = `Bearer ${key}`;
                }
                transport = new StreamableHTTPTransport(url, {
                    reconnectionOptions: {
                        maxRetries: 0,
                        initialReconnectionDelay: 1000,
                        maxReconnectionDelay: 1000,
                        reconnectionDelayGrowFactor: 1
                    },
                    requestInit: { headers, redirect: 'error' },
                    fetch: async (target, options) => {
                        if (new URL(target).origin !== url.origin) throw Error('MCP origin changed');
                        return fetch(target, {
                            ...options,
                            redirect: 'error',
                            signal: options?.signal
                                ? AbortSignal.any([options.signal, bounded])
                                : bounded
                        });
                    }
                });
                stage = 'connection';
            }

            const startTransport = transport.start.bind(transport);
            transport.start = async (...args) => {
                stage = config.transport === 'stdio' ? 'process_launch' : 'connection';
                try {
                    const result = await startTransport(...args);
                    stage = 'connection';
                    return result;
                } catch {
                    fail(stage, stage === 'process_launch' ? 'process_unavailable' : 'mcp_connection_failed');
                    throw Error('MCP operation unavailable');
                }
            };

            const originalRequest = client.request.bind(client);
            client.request = async (request, ...args) => {
                if (request?.method === 'initialize') stage = 'initialization';
                try {
                    return await originalRequest(request, ...args);
                } catch (error) {
                    if (request?.method === 'initialize') {
                        fail('initialization', 'mcp_initialization_failed');
                    }
                    throw error;
                }
            };

            try {
                await client.connect(transport, { signal: bounded, timeout: 8000 });
                bounded.throwIfAborted();
            } catch {
                fail(stage, stage === 'initialization' ? 'mcp_initialization_failed' : 'mcp_connection_failed');
                throw Error('MCP operation unavailable');
            }

            return await action(
                client,
                bounded,
                nextStage => { stage = nextStage; },
                (failureStage, category) => fail(failureStage, category)
            );
        } catch {
            if (!failureReported) {
                const category = stage === 'process_launch' ? 'process_unavailable'
                    : stage === 'connection' ? 'mcp_connection_failed'
                        : stage === 'initialization' ? 'mcp_initialization_failed'
                            : stage === 'tools_call' ? 'mcp_call_failed'
                                : stage === 'result_validation' ? 'invalid_tool_result'
                                    : 'serialization_failed';
                fail(stage, category);
            }
            throw Error('MCP operation unavailable');
        } finally {
            await client.close().catch(() => {});
            await transport?.close().catch(() => {});
        }
    }

    async function discover(config, options) {
        return withMcp(config, async (client, signal) => {
            const result = await client.listTools({}, { signal, timeout: 8000 });
            return result.tools.slice(0, 100).map(tool => ({
                name: tool.name,
                description: String(tool.description || '').slice(0, 1000),
                inputSchema: tool.inputSchema
            }));
        }, options);
    }

    async function invoke(config, name, args, options = {}) {
        if (!config.enabledTools?.includes(name)) {
            reportFailure(options.onFailure, 'policy_validation', 'tool_not_authorized');
            throw Error('MCP tool disabled');
        }
        return withMcp(config, async (client, signal, setStage, fail) => {
            setStage('tools_call');
            let result;
            try {
                result = await client.callTool(
                    { name, arguments: args },
                    undefined,
                    { signal, timeout: 8000 }
                );
            } catch {
                throw Error('MCP operation unavailable');
            }

            setStage('result_validation');
            if (!result || typeof result !== 'object' || Array.isArray(result) ||
                !Array.isArray(result.content)) {
                throw Error('Invalid MCP tool result');
            }

            setStage('result_serialization');
            let serialized;
            try { serialized = JSON.stringify(result); } catch {
                throw Error('MCP tool result unavailable');
            }
            if (typeof serialized !== 'string') throw Error('MCP tool result unavailable');
            if (serialized.length > 32768) {
                fail('result_serialization', 'tool_result_too_large');
                throw Error('MCP output too large');
            }
            return result;
        }, options);
    }

    return { discover, invoke };
}

module.exports = { ...createMcpClient(), createMcpClient };
