'use strict';
const { performance } = require('node:perf_hooks');

function createGpuTelemetryStorage(db) {
    let sampling = false, lastSample = -Infinity, sampleIntervalMs = 5000;

    function storeSample(sample) {
        if (!sample || typeof sample !== 'object') return 0;

        const gpuState = sample.gpu?.state === 'available' ? sample.gpu.devices : [];
        const backend = sample.backend || {};
        const sampledAtMs = Math.floor(new Date(sample.sampledAt).getTime());
        let rowsInserted = 0;

        try {
            const insertStmt = db.prepare(`
                INSERT INTO gpu_telemetry (
                    sampled_at, sampled_at_unix_ms, gpu_index, gpu_uuid, gpu_name, driver,
                    utilization_percent, memory_used_mib, memory_total_mib, temperature_c, power_w, power_limit_w,
                    backend_state, backend_model, context_per_slot, parallel_slots, metrics_state,
                    generated_tokens_per_second, prompt_tokens_per_second, active_requests
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
            `);

            // Insert backend state once (gpu_index = -1 sentinel)
            if (backend.state) {
                insertStmt.run(
                    sample.sampledAt, sampledAtMs,
                    -1, null, 'backend', null,
                    null, null, null, null, null, null,
                    backend.state, backend.model || null, backend.contextPerSlot || null,
                    backend.parallelSlots || null, backend.metricsState || null,
                    backend.metrics?.generatedTokensPerSecond || null,
                    backend.metrics?.promptTokensPerSecond || null,
                    backend.activeRequests || null
                );
                rowsInserted++;
            }

            // Insert one row per GPU device
            for (let i = 0; i < gpuState.length; i++) {
                const gpu = gpuState[i];
                if (!gpu) continue;
                insertStmt.run(
                    sample.sampledAt, sampledAtMs,
                    i, gpu.uuid || null, gpu.name || null, gpu.driver || null,
                    gpu.utilizationPercent !== null ? gpu.utilizationPercent : null,
                    gpu.memoryUsedMiB !== null ? gpu.memoryUsedMiB : null,
                    gpu.memoryTotalMiB !== null ? gpu.memoryTotalMiB : null,
                    gpu.temperatureC !== null ? gpu.temperatureC : null,
                    gpu.powerW !== null ? gpu.powerW : null,
                    gpu.powerLimitW !== null ? gpu.powerLimitW : null,
                    null, null, null, null, null, null, null, null
                );
                rowsInserted++;
            }

            return rowsInserted;
        } catch (error) {
            console.error('Failed to store GPU telemetry sample:', error.message);
            return 0;
        }
    }

    function pruneOldSamples() {
        try {
            // Keep only last 2 hours
            const twoHoursAgoMs = Date.now() - (2 * 60 * 60 * 1000);
            const deleted = db.prepare(`
                DELETE FROM gpu_telemetry WHERE sampled_at_unix_ms < ?
            `).run(twoHoursAgoMs).changes;
            return deleted;
        } catch (error) {
            console.error('Failed to prune old GPU telemetry:', error.message);
            return 0;
        }
    }

    async function pollAndStore(getAdminTelemetry) {
        if (sampling) return 0; // Skip if already collecting
        const now = performance.now();
        if (now - lastSample < sampleIntervalMs) return 0; // Rate limit

        sampling = true;
        try {
            const sample = await getAdminTelemetry();
            const rowsInserted = storeSample(sample);
            lastSample = now;

            // Prune old records every 60 samples (~5 minutes at 5s interval)
            if (Math.floor(now / sampleIntervalMs) % 60 === 0) {
                pruneOldSamples();
            }

            return rowsInserted;
        } catch (error) {
            console.error('GPU telemetry collection error:', error.message);
            return 0;
        } finally {
            sampling = false;
        }
    }

    function getHistory(timeRangeMs) {
        try {
            const startTimeMs = Date.now() - timeRangeMs;
            const rows = db.prepare(`
                SELECT
                    sampled_at, gpu_index, gpu_uuid, gpu_name, driver,
                    utilization_percent, memory_used_mib, memory_total_mib, temperature_c, power_w, power_limit_w,
                    backend_state, backend_model, context_per_slot, parallel_slots, metrics_state,
                    generated_tokens_per_second, prompt_tokens_per_second, active_requests
                FROM gpu_telemetry
                WHERE sampled_at_unix_ms >= ?
                ORDER BY sampled_at_unix_ms ASC, gpu_index ASC
            `).all(startTimeMs);

            return rows;
        } catch (error) {
            console.error('Failed to fetch GPU telemetry history:', error.message);
            return [];
        }
    }

    function getStatistics(timeRangeMs) {
        try {
            const startTimeMs = Date.now() - timeRangeMs;
            const stats = db.prepare(`
                SELECT
                    COUNT(*) as total_samples,
                    COUNT(DISTINCT sampled_at_unix_ms) as distinct_times,
                    MIN(sampled_at_unix_ms) as earliest_ms,
                    MAX(sampled_at_unix_ms) as latest_ms
                FROM gpu_telemetry
                WHERE sampled_at_unix_ms >= ?
            `).get(startTimeMs);

            return stats || { total_samples: 0, distinct_times: 0, earliest_ms: null, latest_ms: null };
        } catch (error) {
            console.error('Failed to fetch GPU telemetry statistics:', error.message);
            return { total_samples: 0, distinct_times: 0, earliest_ms: null, latest_ms: null };
        }
    }

    return {
        storeSample,
        pruneOldSamples,
        pollAndStore,
        getHistory,
        getStatistics,
        setSampleInterval: (ms) => { sampleIntervalMs = Math.max(1000, ms); }
    };
}

module.exports = { createGpuTelemetryStorage };
