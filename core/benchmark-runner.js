'use strict';

const { randomUUID } = require('node:crypto');

const MAX_REPETITIONS = 20;
const MAX_WARMUPS = 5;
const MAX_PROMPT_TOKENS = 2048;
const MAX_OUTPUT_TOKENS = 1024;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
const MAX_SSE_BYTES = 2 * 1024 * 1024;
const WORDS = Object.freeze([
    'amber', 'birch', 'cobalt', 'drift', 'ember', 'field', 'granite', 'harbor',
    'indigo', 'juniper', 'kinetic', 'lantern', 'meadow', 'north', 'orbit', 'prairie',
    'quartz', 'river', 'silver', 'timber', 'upland', 'violet', 'willow', 'yellow'
]);

function validateBenchmark(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => ![
            'name', 'target', 'promptTokenTarget', 'outputTokenLimit', 'repetitions',
            'warmupRepetitions', 'concurrency', 'temperature', 'seed', 'timeoutMs'
        ].includes(key))) throw new TypeError('Invalid benchmark configuration');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new TypeError('Invalid benchmark name');
    }
    if (input.target !== 'local-llama') throw new TypeError('Unsupported benchmark target');
    const integer = (key, minimum, maximum) => {
        if (!Number.isSafeInteger(input[key]) || input[key] < minimum || input[key] > maximum) {
            throw new TypeError(`Invalid ${key}`);
        }
        return input[key];
    };
    const promptTokenTarget = integer('promptTokenTarget', 32, MAX_PROMPT_TOKENS);
    const outputTokenLimit = integer('outputTokenLimit', 1, MAX_OUTPUT_TOKENS);
    const repetitions = integer('repetitions', 1, MAX_REPETITIONS);
    const warmupRepetitions = integer('warmupRepetitions', 0, MAX_WARMUPS);
    if (input.concurrency !== 1) throw new TypeError('Concurrency must be one');
    const timeoutMs = integer('timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) ||
        input.temperature < 0 || input.temperature > 2) throw new TypeError('Invalid temperature');
    if (input.seed !== null && input.seed !== undefined &&
        (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 2147483647)) {
        throw new TypeError('Invalid seed');
    }
    return Object.freeze({
        name, target: 'local-llama', promptTokenTarget, outputTokenLimit, repetitions,
        warmupRepetitions, concurrency: 1, temperature: input.temperature,
        seed: input.seed ?? null, timeoutMs
    });
}

function deterministicPrompt(target) {
    const count = Math.ceil(target / WORDS.length);
    const sequence = Array.from({ length: count }, (_, index) =>
        WORDS.map((word, wordIndex) => WORDS[(wordIndex + index) % WORDS.length]).join(' ')
    ).join(' ');
    return `Continue this deterministic benchmark sequence by briefly describing its pattern. ${sequence}`;
}

function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeTiming(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = (sorted.length - 1) * fraction;
    const lower = Math.floor(middle);
    const upper = Math.ceil(middle);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (middle - lower);
}

function summarize(run, results) {
    const measurements = results.filter(result => result.phase === 'measurement');
    const successful = measurements.filter(result => result.status === 'success');
    const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const numeric = (key, rows = successful) => rows.map(row => row[key]).filter(Number.isFinite);
    const latencies = numeric('durationMs');
    const throughputs = numeric('endToEndOutputTokensPerSecond');
    const ttfts = numeric('timeToFirstTokenMs');
    return {
        runId: run.run_id,
        benchmarkId: run.benchmark_id,
        name: run.name,
        target: run.target,
        configuration: run.configuration,
        status: run.status,
        createdAt: run.created_at,
        finishedAt: run.finished_at,
        totalRepetitions: run.total_repetitions,
        completedRepetitions: run.completed_repetitions,
        model: run.model,
        hardware: run.hardware,
        errorCategory: run.error_category,
        results,
        summary: {
            successfulRepetitions: successful.length,
            failedRepetitions: measurements.filter(result => result.status !== 'success').length,
            warmupRepetitions: results.filter(result => result.phase === 'warmup').length,
            averageLatencyMs: mean(latencies),
            medianLatencyMs: percentile(latencies, 0.5),
            averageEndToEndOutputTokensPerSecond: mean(throughputs),
            medianEndToEndOutputTokensPerSecond: percentile(throughputs, 0.5),
            averageTimeToFirstTokenMs: mean(ttfts),
            medianTimeToFirstTokenMs: percentile(ttfts, 0.5),
            averagePromptTokensPerSecond: mean(numeric('promptTokensPerSecond'))
        }
    };
}

function createBenchmarkRunner({
    db,
    createChatCompletion,
    readSlots,
    getModel,
    getHardware = async () => null,
    now = () => new Date(),
    createId = randomUUID,
    clock = () => performance.now(),
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    busyWaitMs = 60000,
    busyPollMs = 1000
}) {
    if (!db || typeof db.prepare !== 'function' || typeof createChatCompletion !== 'function' ||
        typeof readSlots !== 'function' || typeof getModel !== 'function') {
        throw new TypeError('Benchmark storage and local llama client functions are required');
    }
    if (!Number.isSafeInteger(busyWaitMs) || busyWaitMs < 0 ||
        !Number.isSafeInteger(busyPollMs) || busyPollMs < 1) throw new TypeError('Invalid busy wait limits');

    let active = null;
    let activeChatRequests = 0;
    db.prepare(`UPDATE llm_benchmark_runs
        SET status='failed', finished_at=?, error_category='interrupted_by_restart'
        WHERE status IN ('queued','running')`).run(now().toISOString());

    function checkSlots(slots) {
        if (slots && slots.status !== undefined) {
            if (slots.status !== 200 || typeof slots.text !== 'string') {
                throw Object.assign(new Error('Busy state unavailable'), { code: 'busy_state_unavailable' });
            }
            try { slots = JSON.parse(slots.text); } catch {
                throw Object.assign(new Error('Busy state unavailable'), { code: 'busy_state_unavailable' });
            }
        }
        const values = Array.isArray(slots) ? slots : slots && Array.isArray(slots.slots) ? slots.slots : null;
        if (!values || values.length === 0 || values.length > 16 ||
            values.some(slot => !slot || typeof slot.is_processing !== 'boolean')) {
            throw Object.assign(new Error('Busy state unavailable'), { code: 'busy_state_unavailable' });
        }
        return values.some(slot => slot.is_processing);
    }

    async function waitUntilIdle(signal, waitLimit = busyWaitMs) {
        const deadline = clock() + waitLimit;
        for (;;) {
            signal.throwIfAborted();
            const busy = activeChatRequests > 0 || checkSlots(await readSlots({ signal }));
            if (!busy) return;
            if (clock() >= deadline) {
                throw Object.assign(new Error('Local server busy'), { code: 'server_busy' });
            }
            await sleep(Math.min(busyPollMs, Math.max(1, deadline - clock())), signal);
        }
    }

    async function requestMeasurement(configuration, model, signal) {
        const controller = new AbortController();
        const timeout = AbortSignal.timeout(configuration.timeoutMs);
        const combined = AbortSignal.any([signal, controller.signal, timeout]);
        const started = clock();
        let firstTokenAt = null;
        let usage = null;
        let timings = null;
        let response;
        try {
            response = await createChatCompletion({
                model,
                messages: [{ role: 'user', content: deterministicPrompt(configuration.promptTokenTarget) }],
                stream: true,
                stream_options: { include_usage: true },
                max_tokens: configuration.outputTokenLimit,
                temperature: configuration.temperature,
                ...(configuration.seed === null ? {} : { seed: configuration.seed })
            }, { signal: combined });
            if (!response || !Number.isInteger(response.status)) throw Object.assign(new Error(), { code: 'invalid_response' });
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw Object.assign(new Error(), {
                    code: response.status === 401 || response.status === 403 ? 'authentication' :
                        response.status === 429 ? 'rate_limited' :
                            response.status >= 500 ? 'server_error' : 'request_rejected'
                });
            }
            if (!response.body || !/^text\/event-stream(?:;|$)/i.test(response.headers?.get?.('content-type') || '')) {
                await response.body?.cancel().catch(() => {});
                throw Object.assign(new Error(), { code: 'invalid_response' });
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let buffer = '';
            let eventData = [];
            let byteCount = 0;
            let done = false;
            try {
                while (!done) {
                    const { value, done: streamDone } = await reader.read();
                    buffer += decoder.decode(value, { stream: !streamDone });
                    if (buffer.length > MAX_SSE_BYTES) throw Object.assign(new Error(), { code: 'invalid_response' });
                    let newline;
                    while ((newline = buffer.indexOf('\n')) >= 0 || (streamDone && buffer.length)) {
                        const line = (newline < 0 ? buffer : buffer.slice(0, newline)).replace(/\r$/, '');
                        buffer = newline < 0 ? '' : buffer.slice(newline + 1);
                        if (line.startsWith('data:')) {
                            const part = line.slice(5).replace(/^ /, '');
                            eventData.push(part);
                            byteCount += part.length;
                            if (byteCount > MAX_SSE_BYTES) throw Object.assign(new Error(), { code: 'invalid_response' });
                        } else if (!line && eventData.length) {
                            const raw = eventData.join('\n');
                            eventData = [];
                            byteCount = 0;
                            if (raw === '[DONE]') {
                                done = true;
                                break;
                            }
                            let event;
                            try { event = JSON.parse(raw); } catch {
                                throw Object.assign(new Error(), { code: 'invalid_response' });
                            }
                            if (event.error || !Array.isArray(event.choices) || event.choices.length > 1) {
                                throw Object.assign(new Error(), { code: 'invalid_response' });
                            }
                            if (event.usage && typeof event.usage === 'object') usage = event.usage;
                            if (event.timings && typeof event.timings === 'object') timings = event.timings;
                            const content = event.choices[0]?.delta?.content;
                            if (typeof content === 'string' && content.length && firstTokenAt === null) {
                                firstTokenAt = Math.max(0, clock() - started);
                            }
                        }
                        if (!buffer && streamDone) break;
                    }
                    if (streamDone && !done) throw Object.assign(new Error(), { code: 'invalid_response' });
                }
            } finally {
                controller.abort();
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            const durationMs = Math.max(0, clock() - started);
            const inputTokens = safeCount(usage?.prompt_tokens);
            const outputTokens = safeCount(usage?.completion_tokens);
            const promptCount = safeCount(timings?.prompt_n);
            const promptDuration = safeTiming(timings?.prompt_ms);
            const promptTokensPerSecond = promptCount !== null && promptDuration !== null && promptDuration > 0
                ? promptCount * 1000 / promptDuration
                : safeTiming(timings?.prompt_per_second);
            return {
                status: 'success',
                inputTokens,
                outputTokens,
                durationMs,
                timeToFirstTokenMs: firstTokenAt,
                endToEndOutputTokensPerSecond: outputTokens !== null && durationMs > 0
                    ? outputTokens * 1000 / durationMs : null,
                promptTokensPerSecond,
                errorCategory: null
            };
        } catch (error) {
            const cancelled = signal.aborted || error?.name === 'AbortError' && signal.aborted;
            const timedOut = !cancelled && (timeout.aborted || error?.name === 'TimeoutError');
            const durationMs = Math.max(0, clock() - started);
            const inputTokens = safeCount(usage?.prompt_tokens);
            const outputTokens = safeCount(usage?.completion_tokens);
            const promptCount = safeCount(timings?.prompt_n);
            const promptDuration = safeTiming(timings?.prompt_ms);
            return {
                status: cancelled ? 'cancelled' : 'failed',
                inputTokens,
                outputTokens,
                durationMs,
                timeToFirstTokenMs: firstTokenAt,
                endToEndOutputTokensPerSecond: outputTokens !== null && durationMs > 0
                    ? outputTokens * 1000 / durationMs : null,
                promptTokensPerSecond: promptCount !== null && promptDuration !== null && promptDuration > 0
                    ? promptCount * 1000 / promptDuration : safeTiming(timings?.prompt_per_second),
                errorCategory: cancelled ? 'cancelled' : timedOut ? 'timeout' :
                    typeof error?.code === 'string' &&
                        ['busy_state_unavailable', 'server_busy', 'authentication', 'rate_limited',
                            'server_error', 'request_rejected', 'invalid_response'].includes(error.code)
                        ? error.code : 'request_failed'
            };
        } finally {
            controller.abort();
        }
    }

    function persistResult(runId, repetition, phase, result) {
        db.prepare(`INSERT INTO llm_benchmark_results (
            run_id, repetition, phase, status, input_tokens, output_tokens, duration_ms,
            time_to_first_token_ms, end_to_end_output_tokens_per_second,
            prompt_tokens_per_second, error_category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            runId, repetition, phase, result.status, result.inputTokens ?? null,
            result.outputTokens ?? null, result.durationMs ?? null,
            result.timeToFirstTokenMs ?? null, result.endToEndOutputTokensPerSecond ?? null,
            result.promptTokensPerSecond ?? null, result.errorCategory ?? null
        );
        db.prepare(`UPDATE llm_benchmark_runs SET completed_repetitions=completed_repetitions+1
            WHERE run_id=?`).run(runId);
    }

    async function execute(job) {
        const { runId, benchmarkId, configuration, controller } = job;
        let status = 'completed';
        let runError = null;
        try {
            const model = job.model;
            db.prepare(`UPDATE llm_benchmark_runs SET status='running', model=? WHERE run_id=?`)
                .run(model, runId);
            const repetitions = configuration.warmupRepetitions + configuration.repetitions;
            for (let index = 0; index < repetitions; index++) {
                if (controller.signal.aborted) {
                    status = 'cancelled';
                    break;
                }
                const phase = index < configuration.warmupRepetitions ? 'warmup' : 'measurement';
                let result;
                try {
                    await waitUntilIdle(controller.signal);
                    result = await requestMeasurement(configuration, model, controller.signal);
                } catch (error) {
                    result = {
                        status: controller.signal.aborted ? 'cancelled' : 'failed',
                        errorCategory: controller.signal.aborted ? 'cancelled' :
                            ['server_busy', 'busy_state_unavailable'].includes(error?.code)
                                ? error.code : 'request_failed'
                    };
                }
                persistResult(runId, index + 1, phase, result);
                if (result.status === 'cancelled') {
                    status = 'cancelled';
                    break;
                }
            }
        } catch (error) {
            status = controller.signal.aborted ? 'cancelled' : 'failed';
            runError = controller.signal.aborted ? 'cancelled' :
                error?.code === 'model_unavailable' ? 'model_unavailable' : 'runner_failed';
        } finally {
            db.prepare(`UPDATE llm_benchmark_runs SET status=?, finished_at=?, error_category=?
                WHERE run_id=?`).run(status, now().toISOString(), runError, runId);
            active = null;
            job.resolveDone();
        }
    }

    async function start(ownerId, input, authorize = () => true) {
        if (active) throw Object.assign(new Error('A benchmark is already active'), { code: 'benchmark_active' });
        const configuration = validateBenchmark(input);
        if (typeof ownerId !== 'string' || !ownerId || typeof authorize !== 'function') {
            throw new TypeError('An administrator identity is required');
        }
        const controller = new AbortController();
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const reservation = { runId: null, benchmarkId: null, configuration, controller, done, resolveDone };
        active = reservation;
        try {
            await waitUntilIdle(controller.signal, 0);
            const model = await getModel();
            if (typeof model !== 'string' || !model || model.length > 256) {
                throw Object.assign(new Error('Local model is unavailable'), { code: 'model_unavailable' });
            }
            let hardware = null;
            try {
                const observation = await getHardware();
                if (observation && typeof observation === 'object' && !Array.isArray(observation)) {
                    hardware = observation;
                }
            } catch {}
            if (!await authorize()) {
                throw Object.assign(new Error('Session no longer authorized'), { code: 'session_revoked' });
            }
            const benchmarkId = createId();
            const runId = createId();
            const createdAt = now().toISOString();
            const total = configuration.repetitions + configuration.warmupRepetitions;
            const hardwareJson = hardware === null ? null : JSON.stringify(hardware);
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare(`INSERT INTO llm_benchmarks (
                    benchmark_id, owner_id, name, target, configuration_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)`).run(
                    benchmarkId, ownerId, configuration.name, configuration.target,
                    JSON.stringify(configuration), createdAt
                );
                db.prepare(`INSERT INTO llm_benchmark_runs (
                    run_id, benchmark_id, status, created_at, total_repetitions, model
                ) VALUES (?, ?, 'queued', ?, ?, ?)`).run(runId, benchmarkId, createdAt, total, model);
                db.prepare('UPDATE llm_benchmark_runs SET hardware_json=? WHERE run_id=?')
                    .run(hardwareJson && hardwareJson.length <= 2048 ? hardwareJson : null, runId);
                db.exec('COMMIT');
            } catch (error) {
                if (db.isTransaction) db.exec('ROLLBACK');
                if (db.prepare(`SELECT 1 FROM llm_benchmark_runs
                    WHERE status IN ('queued','running') LIMIT 1`).get()) {
                    throw Object.assign(new Error('A benchmark is already active'), { code: 'benchmark_active' });
                }
                throw error;
            }
            reservation.runId = runId;
            reservation.benchmarkId = benchmarkId;
            reservation.model = model;
            void execute(reservation).catch(() => {
                if (active === reservation) active = null;
                reservation.resolveDone();
                console.error('Benchmark execution could not persist its final status.');
            });
            return getRun(runId);
        } catch (error) {
            if (active === reservation) active = null;
            reservation.resolveDone();
            if (controller.signal.aborted) {
                throw Object.assign(new Error('Benchmark yielded to ordinary chat traffic'), { code: 'server_busy' });
            }
            throw error;
        }
    }

    async function beginChatRequest() {
        activeChatRequests++;
        const job = active;
        if (job) {
            job.controller.abort();
            await job.done;
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            activeChatRequests = Math.max(0, activeChatRequests - 1);
        };
    }

    async function stop() {
        const job = active;
        if (!job) return;
        job.controller.abort();
        await job.done;
    }

    function cancel(runId) {
        if (!active || active.runId !== runId) return false;
        active.controller.abort();
        return true;
    }

    function parseRow(row) {
        if (!row) return null;
        return {
            ...row,
            configuration: JSON.parse(row.configuration_json),
            hardware: row.hardware_json ? JSON.parse(row.hardware_json) : null
        };
    }

    function getRun(runId) {
        const row = db.prepare(`SELECT r.*, b.benchmark_id, b.name, b.target,
            b.configuration_json FROM llm_benchmark_runs r
            JOIN llm_benchmarks b ON b.benchmark_id=r.benchmark_id WHERE r.run_id=?`).get(runId);
        if (!row) return null;
        const results = db.prepare(`SELECT repetition, phase, status, input_tokens AS inputTokens,
            output_tokens AS outputTokens, duration_ms AS durationMs,
            time_to_first_token_ms AS timeToFirstTokenMs,
            end_to_end_output_tokens_per_second AS endToEndOutputTokensPerSecond,
            prompt_tokens_per_second AS promptTokensPerSecond, error_category AS errorCategory
            FROM llm_benchmark_results WHERE run_id=? ORDER BY repetition`).all(runId);
        return summarize(parseRow(row), results);
    }

    function listRuns(limit = 20) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid run limit');
        const rows = db.prepare(`SELECT r.run_id FROM llm_benchmark_runs r
            ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`).all(limit);
        return rows.map(row => getRun(row.run_id));
    }

    return Object.freeze({
        start,
        cancel,
        getRun,
        listRuns,
        beginChatRequest,
        stop,
        get activeRunId() { return active?.runId ?? null; }
    });
}

function exportCsv(run) {
    const quote = value => {
        let text = String(value ?? '');
        if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [
        ['runId', 'benchmarkId', 'name', 'target', 'status', 'createdAt', 'finishedAt',
            'model', 'promptTokenTarget', 'outputTokenLimit', 'repetitions', 'warmupRepetitions',
            'concurrency', 'temperature', 'seed', 'timeoutMs', 'repetition', 'phase',
            'resultStatus', 'inputTokens', 'outputTokens', 'durationMs', 'timeToFirstTokenMs',
            'endToEndOutputTokensPerSecond', 'promptTokensPerSecond', 'errorCategory', 'hardware']
    ];
    for (const result of run.results) {
        rows.push([
            run.runId, run.benchmarkId, run.name, run.target, run.status, run.createdAt,
            run.finishedAt, run.model, run.configuration.promptTokenTarget,
            run.configuration.outputTokenLimit, run.configuration.repetitions,
            run.configuration.warmupRepetitions, run.configuration.concurrency,
            run.configuration.temperature, run.configuration.seed, run.configuration.timeoutMs,
            result.repetition, result.phase, result.status, result.inputTokens, result.outputTokens,
            result.durationMs, result.timeToFirstTokenMs,
            result.endToEndOutputTokensPerSecond, result.promptTokensPerSecond,
            result.errorCategory, JSON.stringify(run.hardware)
        ]);
    }
    return rows.map(row => row.map(quote).join(',')).join('\r\n');
}

module.exports = {
    createBenchmarkRunner,
    validateBenchmark,
    deterministicPrompt,
    exportCsv,
    MAX_REPETITIONS,
    MAX_WARMUPS,
    MAX_PROMPT_TOKENS,
    MAX_OUTPUT_TOKENS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS
};
