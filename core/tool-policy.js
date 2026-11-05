'use strict';

function createToolPolicy({ tools = [], confirm = async () => false, timeoutMs = 10000, maxOutput = 32768 } = {}) {
    const registry = new Map(tools.map(tool => [tool.name, tool]));
    const operations = new Map();

    return {
        definitions: () => tools.filter(tool => tool.enabled).map(tool => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters }
        })),
        async execute({ user, operationId, name, args, signal, onFailure = () => {} }) {
            const report = (stage, errorCategory) => {
                try { onFailure(stage, errorCategory); } catch {}
            };
            if (!user || typeof operationId !== 'string' || !operationId || operationId.length > 160) {
                report('policy_validation', 'tool_not_authorized');
                throw Error('Tool authorization required');
            }
            const key = `${user}:${operationId}`;
            if (operations.has(key)) {
                report('policy_validation', 'policy_rejected');
                throw Error('Duplicate tool operation');
            }
            if (operations.size >= 10000) {
                report('policy_validation', 'policy_rejected');
                throw Error('Tool operation capacity reached');
            }

            const tool = registry.get(name);
            let authorized = false;
            try { authorized = !!tool?.enabled && !!tool.allowed(user); } catch {}
            if (!authorized) {
                report('policy_validation', 'tool_not_authorized');
                throw Error('Tool not authorized');
            }

            let argsSize;
            try { argsSize = JSON.stringify(args)?.length; } catch {}
            if (!args || typeof args !== 'object' || Array.isArray(args) ||
                !Number.isSafeInteger(argsSize) || argsSize > 8192) {
                report('policy_validation', 'invalid_tool_arguments');
                throw Error('Invalid tool arguments');
            }

            operations.set(key, 'reserved');
            try {
                if (tool.consequential && !await confirm({ user, operationId, name, args })) {
                    operations.set(key, 'denied');
                    report('policy_validation', 'policy_rejected');
                    throw Error('Explicit action confirmation required');
                }
            } catch (error) {
                if (operations.get(key) !== 'denied') report('policy_validation', 'policy_rejected');
                throw error;
            }

            const controller = new AbortController();
            const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
            let timer;
            try {
                combined.throwIfAborted();
                const result = await Promise.race([
                    Promise.resolve().then(() => tool.run(args, { signal: combined, onFailure })),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            controller.abort();
                            reject(Error('Tool timeout; outcome unknown'));
                        }, timeoutMs);
                    })
                ]);
                combined.throwIfAborted();

                let serialized;
                try { serialized = JSON.stringify(result); } catch {}
                if (typeof serialized !== 'string') {
                    report('result_serialization', 'serialization_failed');
                    throw Error('Tool output unavailable');
                }
                if (serialized.length > maxOutput) {
                    report('result_serialization', 'tool_result_too_large');
                    throw Error('Tool output too large');
                }
                operations.set(key, 'completed');
                return { untrusted: true, result };
            } catch {
                operations.set(key, 'uncertain');
                throw Error('Tool failed; automatic retry prohibited');
            } finally {
                clearTimeout(timer);
            }
        }
    };
}

async function runToolLoop({
    complete, messages, policy, user, operationId, signal,
    onActivity = () => {}, onDiagnostic = () => {}, maxRounds = 3, maxCalls = 5
}) {
    const history = structuredClone(messages);
    let calls = 0;
    const reportFailure = (toolName, startedAt, stage, errorCategory) => {
        try {
            onDiagnostic({
                correlationId: operationId,
                toolName,
                stage,
                errorCategory,
                durationMs: Math.max(0, Math.floor(Number(process.hrtime.bigint() - startedAt) / 1e6))
            });
        } catch {}
    };

    for (let round = 0; round <= maxRounds; round++) {
        signal?.throwIfAborted();
        const message = await complete({ messages: history, tools: policy.definitions(), signal });
        if (!message || message.role !== 'assistant') throw Error('Invalid tool response');
        if (!message.tool_calls?.length) return message;
        if (round === maxRounds) throw Error('Tool round limit reached');
        history.push(message);

        for (const call of message.tool_calls) {
            if (++calls > maxCalls) throw Error('Tool execution limit reached');
            if (call.type !== 'function' || typeof call.id !== 'string') throw Error('Invalid tool call');

            const toolName = call.function?.name;
            const startedAt = process.hrtime.bigint();
            onActivity({ state: 'running', name: toolName });

            let args;
            try {
                args = JSON.parse(call.function.arguments);
            } catch {
                reportFailure(toolName, startedAt, 'argument_parsing', 'invalid_tool_arguments');
                onActivity({ state: 'failed', name: toolName });
                throw Error('Tool operation failed');
            }

            try {
                const result = await policy.execute({
                    user,
                    operationId: `${operationId}:${call.id}`,
                    name: toolName,
                    args,
                    signal,
                    onFailure: (stage, errorCategory) =>
                        reportFailure(toolName, startedAt, stage, errorCategory)
                });
                let content;
                try { content = JSON.stringify(result); } catch {}
                if (typeof content !== 'string') {
                    reportFailure(toolName, startedAt, 'result_serialization', 'serialization_failed');
                    throw Error('Tool output unavailable');
                }
                history.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content
                });
                onActivity({ state: 'completed', name: toolName });
            } catch {
                onActivity({ state: 'failed', name: toolName });
                throw Error('Tool operation failed');
            }
        }
    }
}

module.exports = { createToolPolicy, runToolLoop };
