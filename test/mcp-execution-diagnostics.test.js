'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createMcpClient } = require('../core/mcp-client');
const { createToolPolicy, runToolLoop } = require('../core/tool-policy');
const { initializeSchema } = require('../core/database-schema');
const { createSystemLogService } = require('../core/system-logs');

const fixture = path.join(__dirname, 'support', 'mcp-readonly-fixture.cjs');
const toolName = 'local-fixture__fixture_status';
const fixtureConfig = {
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    enabledTools: ['fixture_status']
};

function fakeMcpClient(failure, result) {
    class Transport {
        async start() {
            if (failure === 'process_launch') throw Error('private launch detail');
        }
        async close() {}
    }

    class Client {
        async connect(transport) {
            await transport.start();
            if (failure === 'connection') throw Error('private connection detail');
            await this.request({ method: 'initialize' });
        }
        async request() {
            if (failure === 'initialization') throw Error('private initialize detail');
        }
        async callTool() {
            if (failure === 'tools_call') throw Error('private call detail');
            return result;
        }
        async close() {}
    }

    return createMcpClient({ ClientImpl: Client, StdioTransport: Transport });
}

function makeTool(run) {
    return {
        name: toolName,
        enabled: true,
        allowed: () => true,
        consequential: false,
        description: 'fixture',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run
    };
}

async function runSingleTool({ policy, argumentsText = '{}', onDiagnostic = () => {} } = {}) {
    let responseCount = 0;
    return runToolLoop({
        complete: async () => ++responseCount === 1
            ? {
                role: 'assistant',
                tool_calls: [{
                    id: 'fixture-call',
                    type: 'function',
                    function: { name: toolName, arguments: argumentsText }
                }]
            }
            : { role: 'assistant', content: 'Synthetic fixture result received.' },
        messages: [{ role: 'user', content: 'private prompt content' }],
        policy,
        user: 'diagnostic-user',
        operationId: '00000000-0000-4000-8000-000000000001',
        onDiagnostic,
        onActivity() {}
    });
}

test('successful fixture execution completes without emitting failure diagnostics', async () => {
    const client = createMcpClient();
    const policy = createToolPolicy({
        tools: [makeTool((args, options) => client.invoke(fixtureConfig, 'fixture_status', args, options))]
    });
    const diagnostics = [];
    const final = await runSingleTool({ policy, onDiagnostic: item => diagnostics.push(item) });

    assert.equal(final.content, 'Synthetic fixture result received.');
    assert.deepEqual(diagnostics, []);
});

test('argument parsing and policy validation failures produce stage diagnostics', async () => {
    const diagnostics = [];
    const policy = createToolPolicy({ tools: [makeTool(async () => ({ ok: true }))] });

    await assert.rejects(runSingleTool({
        policy,
        argumentsText: '[]',
        onDiagnostic: item => diagnostics.push(item)
    }), /Tool operation failed/);
    await assert.rejects(runSingleTool({
        policy,
        argumentsText: 'not-json-private',
        onDiagnostic: item => diagnostics.push(item)
    }), /Tool operation failed/);

    assert.deepEqual(diagnostics.map(({ stage, errorCategory }) => ({ stage, errorCategory })), [
        { stage: 'policy_validation', errorCategory: 'invalid_tool_arguments' },
        { stage: 'argument_parsing', errorCategory: 'invalid_tool_arguments' }
    ]);
});

test('process launch, connection, initialization, and call failures have stable sanitized stages', async () => {
    const cases = [
        ['process_launch', 'process_unavailable'],
        ['connection', 'mcp_connection_failed'],
        ['initialization', 'mcp_initialization_failed'],
        ['tools_call', 'mcp_call_failed']
    ];

    for (const [failure, expectedCategory] of cases) {
        const client = fakeMcpClient(failure, { content: [] });
        const diagnostics = [];
        const policy = createToolPolicy({
            tools: [makeTool((args, options) =>
                client.invoke(fixtureConfig, 'fixture_status', args, options))]
        });
        await assert.rejects(runSingleTool({
            policy,
            onDiagnostic: item => diagnostics.push(item)
        }), /Tool operation failed/);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0].stage, failure);
        assert.equal(diagnostics[0].errorCategory, expectedCategory);
    }
});

test('invalid and unserializable tool results have distinct diagnostics', async () => {
    const cases = [
        [{ content: 'not-an-array' }, 'result_validation', 'invalid_tool_result'],
        [{ content: [] }, 'result_serialization', 'serialization_failed']
    ];

    for (const [result, stage, errorCategory] of cases) {
        if (stage === 'result_serialization') {
            result.content.push(result);
        }
        const client = fakeMcpClient(null, result);
        const diagnostics = [];
        const policy = createToolPolicy({
            tools: [makeTool((args, options) =>
                client.invoke(fixtureConfig, 'fixture_status', args, options))]
        });
        await assert.rejects(runSingleTool({
            policy,
            onDiagnostic: item => diagnostics.push(item)
        }), /Tool operation failed/);
        assert.deepEqual(
            diagnostics.map(item => ({ stage: item.stage, errorCategory: item.errorCategory })),
            [{ stage, errorCategory }]
        );
    }
});

test('diagnostic callback failures do not replace tool failures or leak sensitive data', async t => {
    const db = new DatabaseSync(':memory:');
    initializeSchema(db);
    t.after(() => db.close());
    const logs = createSystemLogService({ db });
    t.after(() => logs.stop());
    const client = fakeMcpClient('tools_call');
    const policy = createToolPolicy({
        tools: [makeTool((args, options) =>
            client.invoke(fixtureConfig, 'fixture_status', args, options))]
    });
    const sensitive = 'private-prompt-private-argument-private-result-private-error';

    await assert.rejects(runSingleTool({
        policy,
        argumentsText: '{}',
        onDiagnostic: event => {
            assert.equal(event.correlationId, '00000000-0000-4000-8000-000000000001');
            logs.log('MCP_TOOL_EXECUTION_FAILED', {
                correlationId: event.correlationId,
                metadata: {
                    toolName: event.toolName,
                    stage: event.stage,
                    errorCategory: event.errorCategory,
                    durationMs: event.durationMs,
                    prompt: sensitive,
                    arguments: sensitive,
                    result: sensitive,
                    error: sensitive
                }
            });
        }
    }), /Tool operation failed/);
    await logs.flush();

    const event = logs.list({ eventCode: 'MCP_TOOL_EXECUTION_FAILED' }).events[0];
    assert.equal(event.correlationId, '00000000-0000-4000-8000-000000000001');
    assert.equal(event.metadata.errorCategory, 'mcp_call_failed');
    assert.equal(Number.isSafeInteger(event.metadata.durationMs), true);
    const stored = JSON.stringify(event);
    assert.match(stored, /local-fixture__fixture_status/);
    assert.match(stored, /tools_call/);
    assert.doesNotMatch(stored, /private-prompt|private-argument|private-result|private-error/);
});

test('a throwing diagnostic sink cannot interrupt successful tool execution', async () => {
    const policy = createToolPolicy({ tools: [makeTool(async () => ({ ok: true }))] });
    const final = await runSingleTool({
        policy,
        onDiagnostic: () => { throw Error('diagnostic sink failure'); }
    });
    assert.equal(final.content, 'Synthetic fixture result received.');
});
