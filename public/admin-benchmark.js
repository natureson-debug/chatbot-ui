'use strict';

function createAdminBenchmark({ document, fetch, setTimer = setTimeout, clearTimer = clearTimeout, windowObject = globalThis.window }) {
    const panel = document.getElementById('tab-benchmark');
    const form = document.getElementById('benchmarkForm');
    const status = document.getElementById('benchmarkStatus');
    const resultsBody = document.getElementById('benchmarkResults');
    const runSelect = document.getElementById('benchmarkRunSelect');
    const progress = document.getElementById('benchmarkProgress');
    const progressLabel = document.getElementById('benchmarkProgressLabel');
    const startButton = document.getElementById('benchmarkStart');
    const cancelButton = document.getElementById('benchmarkCancel');
    const exportJson = document.getElementById('benchmarkExportJson');
    const exportCsv = document.getElementById('benchmarkExportCsv');
    const exportXlsx = document.getElementById('benchmarkExportXlsx');
    const exportPdf = document.getElementById('benchmarkExportPdf');
    const analytics = typeof createBenchmarkAnalyticsUI === 'function' ? createBenchmarkAnalyticsUI(document) : null;
    let activeRunId = null;
    let selectedRunId = null;
    let initialized = false;
    let timer = null;
    let loading = false;
    let stopped = false;
    const observedRuns = new Set();

    function notify(severity, title, message) {
        try {
            if (!windowObject?.ChatbotNotifications) return false;
            windowObject.ChatbotNotifications.show({ severity, title, message });
            return true;
        } catch {
            console.warn('Could not display benchmark notification.');
            return false;
        }
    }

    function operationError(error, title, preserveStatus = false) {
        const message = error.status === 401 ? 'Your administrator session expired. Sign in again.' :
            error.status === 409 ? 'The local inference server is busy or another benchmark is running.' :
                error.status === 503 ? 'The local inference server is temporarily unavailable.' :
                    'Benchmark request failed. Please try again.';
        if (notify('error', title, message)) {
            if (!preserveStatus) setStatus('');
        }
        else setStatus(message);
    }

    function active() {
        return !stopped && !document.hidden && !panel.hidden;
    }

    async function request(url, options = {}) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            ...options
        });
        if (!response.ok) {
            const error = new Error(
                response.status === 401 ? 'Your administrator session expired. Sign in again.' :
                    response.status === 409 ? 'The local inference server is busy or another benchmark is running.' :
                        response.status === 503 ? 'The local inference server is temporarily unavailable.' :
                            'Benchmark request failed. Please try again.'
            );
            error.status = response.status;
            throw error;
        }
        return response.json();
    }

    function setStatus(message) {
        status.textContent = message;
    }

    function display(value, suffix = '') {
        return Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : 'Unavailable';
    }

    function render(run) {
        if (!run) return;
        selectedRunId = run.runId;
        activeRunId = ['queued', 'running'].includes(run.status) ? run.runId : null;
        if (activeRunId) observedRuns.add(run.runId);
        else if (observedRuns.has(run.runId) && ['completed', 'failed', 'cancelled'].includes(run.status)) {
            observedRuns.delete(run.runId);
            const outcomes = {
                completed: ['success', 'Benchmark completed', 'Benchmark completed. Results are available in the Benchmark tab.'],
                failed: ['error', 'Benchmark failed', 'Benchmark failed. Review the repetition error categories.'],
                cancelled: ['information', 'Benchmark cancelled', 'Benchmark was cancelled. Results are available in the Benchmark tab.']
            };
            notify(...outcomes[run.status]);
        }
        startButton.disabled = !!activeRunId;
        cancelButton.disabled = !activeRunId;
        runSelect.disabled = !!activeRunId;
        const total = Number.isSafeInteger(run.totalRepetitions) ? run.totalRepetitions : 0;
        const completed = Number.isSafeInteger(run.completedRepetitions) ? run.completedRepetitions : 0;
        progress.max = Math.max(1, total);
        progress.value = Math.min(completed, total);
        progressLabel.textContent = `${completed} / ${total} repetitions`;
        setStatus(run.status === 'running' ? 'Benchmark running…' :
            run.status === 'queued' ? 'Benchmark queued…' :
                run.status === 'completed' ? 'Status: Completed' :
                    run.status === 'cancelled' ? 'Status: Cancelled' :
                        run.status === 'failed' ? 'Status: Failed' : 'Benchmark status unavailable.');
        document.getElementById('benchmarkModel').textContent = run.model || 'Unavailable';
        const gpus = run.hardware?.gpus;
        document.getElementById('benchmarkHardware').textContent = Array.isArray(gpus) && gpus.length
            ? gpus.map(gpu => [gpu.name, gpu.driver].filter(Boolean).join(' · ') || gpu.uuid || 'GPU').join(', ')
            : 'Unavailable';
        const summary = run.summary || {};
        document.getElementById('benchmarkSuccessCount').textContent =
            `${summary.successfulRepetitions ?? 0} / ${summary.failedRepetitions ?? 0}`;
        document.getElementById('benchmarkLatency').textContent =
            `${display(summary.averageLatencyMs, ' ms')} / ${display(summary.medianLatencyMs, ' ms')}`;
        document.getElementById('benchmarkThroughput').textContent =
            `${display(summary.averageEndToEndOutputTokensPerSecond, ' tokens/s')} / ${display(summary.medianEndToEndOutputTokensPerSecond, ' tokens/s')}`;
        document.getElementById('benchmarkTtft').textContent =
            `${display(summary.averageTimeToFirstTokenMs, ' ms')} / ${display(summary.medianTimeToFirstTokenMs, ' ms')}`;
        document.getElementById('benchmarkPromptSpeed').textContent =
            display(summary.averagePromptTokensPerSecond, ' tokens/s');
        resultsBody.replaceChildren();
        for (const result of run.results || []) {
            const row = document.createElement('tr');
            const values = [
                result.repetition, result.phase, result.status, result.inputTokens,
                result.outputTokens, display(result.durationMs, ' ms'),
                display(result.timeToFirstTokenMs, ' ms'),
                display(result.endToEndOutputTokensPerSecond, ' tokens/s'),
                display(result.promptTokensPerSecond, ' tokens/s'),
                result.errorCategory || '—'
            ];
            for (const value of values) {
                const cell = document.createElement('td');
                cell.textContent = value === null || value === undefined ? 'Unavailable' : String(value);
                row.append(cell);
            }
            resultsBody.append(row);
        }
        exportJson.disabled = false;
        exportCsv.disabled = false;
        if (exportXlsx) exportXlsx.disabled = run.status !== 'completed';
        if (exportPdf) exportPdf.disabled = run.status !== 'completed';
        analytics?.render(run);
        if (activeRunId && active()) schedulePoll();
        else clearPoll();
    }

    function schedulePoll() {
        clearPoll();
        if (!active() || !activeRunId) return;
        timer = setTimer(() => {
            timer = null;
            void refreshRun();
        }, 2000);
    }

    function clearPoll() {
        if (timer !== null) clearTimer(timer);
        timer = null;
    }

    async function refreshRun() {
        if (!active() || loading || !selectedRunId) return;
        loading = true;
        try {
            const data = await request(`/api/admin/benchmarks/${encodeURIComponent(selectedRunId)}`);
            if (active()) render(data.run);
        } catch (error) {
            if (active()) {
                if (error.status === 401) {
                    activeRunId = null;
                    startButton.disabled = false;
                    cancelButton.disabled = true;
                    runSelect.disabled = false;
                    clearPoll();
                    setStatus(error.message);
                } else {
                    setStatus('Unable to refresh benchmark status. Retrying shortly.');
                    if (activeRunId) schedulePoll();
                }
            }
        } finally {
            loading = false;
        }
    }

    async function loadRuns(selectLatest = false, preferredRunId = null) {
        const data = await request('/api/admin/benchmarks?limit=50');
        analytics?.setRuns(data.runs || []);
        const current = runSelect.value;
        runSelect.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a run';
        runSelect.append(placeholder);
        for (const run of data.runs || []) {
            const option = document.createElement('option');
            option.value = run.runId;
            option.textContent = `${run.name} · ${new Date(run.createdAt).toLocaleString()} · ${run.status}`;
            runSelect.append(option);
        }
        const chosen = preferredRunId || (selectLatest ? data.runs?.[0]?.runId : current || selectedRunId);
        if (chosen) {
            runSelect.value = chosen;
            const run = (data.runs || []).find(item => item.runId === chosen);
            if (run) render(run);
        }
    }

    async function initialize() {
        if (!active() || initialized) return;
        initialized = true;
        try {
            await loadRuns(true);
            if (!selectedRunId) setStatus('Ready. Starting a benchmark will send requests to the local inference server.');
        } catch (error) {
            initialized = false;
            setStatus(error.status === 401 ? error.message : 'Benchmark history is temporarily unavailable.');
        }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!active() || activeRunId) return;
        startButton.disabled = true;
        setStatus('Checking local server availability…');
        const value = id => document.getElementById(id).value;
        const seedValue = value('benchmarkSeed');
        const body = {
            name: value('benchmarkName'),
            target: value('benchmarkTarget'),
            promptTokenTarget: Number(value('benchmarkPromptTokens')),
            outputTokenLimit: Number(value('benchmarkOutputTokens')),
            repetitions: Number(value('benchmarkRepetitions')),
            warmupRepetitions: Number(value('benchmarkWarmups')),
            concurrency: Number(value('benchmarkConcurrency')),
            temperature: Number(value('benchmarkTemperature')),
            seed: seedValue === '' ? null : Number(seedValue),
            timeoutMs: Number(value('benchmarkTimeout')) * 1000
        };
        let started = false;
        try {
            const data = await request('/api/admin/benchmarks/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            started = true;
            observedRuns.add(data.run.runId);
            render(data.run);
            await loadRuns(false, data.run.runId);
        } catch (error) {
            if (!started) {
                startButton.disabled = false;
                operationError(error, 'Benchmark start failed');
            } else {
                console.warn('Benchmark history could not be refreshed.');
                setStatus('Benchmark started, but history could not be refreshed.');
            }
        }
    });

    cancelButton.addEventListener('click', async () => {
        if (!activeRunId) return;
        cancelButton.disabled = true;
        try {
            const data = await request(`/api/admin/benchmarks/${encodeURIComponent(activeRunId)}/cancel`, { method: 'POST' });
            render(data.run);
        } catch (error) {
            operationError(error, 'Benchmark cancellation failed', true);
            cancelButton.disabled = false;
        }
    });

    runSelect.addEventListener('change', async () => {
        if (!runSelect.value) return;
        selectedRunId = runSelect.value;
        await refreshRun();
    });

    for (const [button, format] of [[exportJson, 'json'], [exportCsv, 'csv'], [exportXlsx, 'xlsx'], [exportPdf, 'pdf']]) {
        if (!button) continue;
        button.addEventListener('click', () => {
            if (!selectedRunId) return;
            windowObject.location.assign(
                `/api/admin/benchmarks/${encodeURIComponent(selectedRunId)}/export?format=${format}`
            );
        });
    }

    document.addEventListener('click', event => {
        if (event.target.closest?.('.admin-tab')) {
            clearPoll();
            setTimer(() => {
                if (active()) {
                    if (!initialized) void initialize();
                    else if (activeRunId) schedulePoll();
                }
            }, 0);
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (!active()) clearPoll();
        else if (!initialized) void initialize();
        else if (activeRunId) schedulePoll();
    });

    return Object.freeze({ initialize, refreshRun, stop() { stopped = true; clearPoll(); } });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createAdminBenchmark };
else if (typeof document !== 'undefined') {
    const benchmark = createAdminBenchmark({ document, fetch: window.fetch.bind(window) });
    window.addEventListener('beforeunload', () => benchmark.stop(), { once: true });
}
