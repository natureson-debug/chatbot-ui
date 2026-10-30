# Phase 1: read-only Admin monitoring

Implemented 2026-10-29. No process controls, scheduler changes, autostart changes, inference requests or database changes. Existing Admin configuration routes and chat behavior are preserved. Source changes require a separately authorized Node restart/deployment before the running server exposes these new routes; none was performed.

## API

- GET `/api/admin/ai/telemetry`: sampledAt (UTC ISO), pollIntervalMs, gpu and backend observations.
- GET `/api/admin/ai/telemetry/status`: same cached backend status and GPU availability, without device readings.
- Existing `/api/admin/ai/status` contract remains unchanged.

Both new routes require the existing authenticated administrator session, authorize before collection/cache access, revalidate the original session and same admin identity after collection, and return Cache-Control: no-store. Anonymous requests receive 401, ordinary users 403, revoked/replaced sessions 401. Unexpected authentication/database errors remain server errors, not success. There is no configurable command, URL, GPU index, path or arbitrary upstream resource supplied by the browser. Static JavaScript contains no secrets or observations.

Healthy and degraded observations use HTTP 200 with explicit source states: available/ready, unavailable, unsupported, authentication_failed or loading_or_unavailable. Null means unknown, never zero. Backend connection failure is labeled unavailable, not proof of process absence. A ready health response does not establish manager ownership or full GPU offload. No configured context fallback is used: contextPerSlot is `/props.default_generation_settings.n_ctx`; parallelSlots is `/props.total_slots`. These values must not be confused with total configured context or model training context.

## Collection and limits

NVIDIA: asynchronous execFile of fixed `C:\Windows\System32\nvidia-smi.exe`, fixed query arguments, shell:false, hidden window, 2.5s timeout, 32KiB output bound. Parses UUID/name/driver, utilization percent, VRAM used/total MiB, GPU temperature Celsius and power draw/limit Watts. Up to 16 devices. Unsupported fields are null. Missing tool/driver/permission errors become unavailable without raw stderr. No NVML dependency added; no fallback to shell/PATH or fabricated data. This Windows path is verified here, not a portable discovery mechanism.

llama.cpp: fixed authenticated GET `/health`, `/v1/models`, `/props`, `/metrics`, reusing the existing key handling and URL configuration in llama-client.js. Each has a 2.5s timeout, redirect rejection and 256KiB body cap. Only whitelisted fields leave the collector; prompts, templates, raw properties and raw Prometheus labels are never forwarded or persisted. No `/slots` request or generation is made. Aggregate generation/prompt rates, token counters and processing/deferred counts are passed through only when supported. Rates are backend averages, not current-request speed; counters are process totals and may reset on restart. Ambiguous labeled/duplicate/invalid numeric metrics remain null.

Collection runs concurrently across sources. All admin clients share one in-flight sample and a five-second server cache, including failures. No background polling without a request, no unbounded histories, no synchronous child-process command, no logging of keys/headers/raw errors. In-flight shared collection may finish after a browser disconnect; it remains bounded and cannot initiate process-management actions.

Backend reference: [b11609 server monitoring documentation](https://github.com/ggml-org/llama.cpp/blob/b11609/tools/server/README.md). Metrics require the optional `--metrics` flag. The present launcher does not enable it. Phase 1 does not enable it or change backend flags.

## Admin UI

Responsive status cards and a horizontally scrollable table of the last 12 distinct samples (approximately one minute at normal cadence). All cards/history use textContent; unavailable fields are explicit and zero remains a valid observation. GPU figures include all applications, not just llama.cpp. State is memory-only, never SQLite/localStorage or chat telemetry.

Polling is sequential, five seconds after each completed request, with an eight-second browser timeout. Hidden tabs suspend/abort; a pause button affects monitoring only. Old responses cannot render after visibility/pause epoch changes. 401/403 clears history and stops polling. Network failure marks retained readings historical; no false zero line. Page exit aborts and clears; back/forward cache restoration reloads for a fresh session check.

## Validation and observed machine

Full repository regression: 282 tests passed, zero failures. New tests: 19 telemetry/route/resource tests plus 5 mocked-DOM monitoring tests. Covers allowlists, missing values, multiple GPUs, upstream offline/auth/unsupported states, timeout configuration, output cap, shared cache/concurrency, admin authorization and revocation, text injection resistance, history cap, duplicate samples, hidden tabs, overlapping polls and network errors. Existing static and SSE harnesses received only the new dependency mock. Mocked DOM tests are not real-browser or visual validation; desktop/mobile visual acceptance remains for review.

A real read-only collector smoke test at 2026-10-29 12:03 Asia/Dubai observed: RTX 3090, driver 610.88, 24576 MiB total / 19587 MiB used, 2% utilization, 33 C, 15.17 W / 350 W. Backend ready; model reported `C:\AI\models\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf`; context per slot 65536; parallel slots 1; metrics unsupported. These are one-time observations, not hard-coded defaults or a capacity guarantee. No GPU/model/driver configuration was changed.

Files: core/admin-telemetry.js (new), core/llama-client.js, server.js, public/admin-monitor.js (new), public/admin.html, public/style.css, test/admin-telemetry.test.js (new), test/admin-monitor.test.js (new), test/static-file-serving.test.js and test/chat-stream-cancellation.test.js (dependency mocks), this document and release/rc1/test-results.txt. Unrelated Continue configuration edits are preserved. No dependencies installed, commits or pushes.

## Review/deployment

Review the diff, then separately authorize Node deployment/restart. Current running server is intentionally unchanged, so newly loaded static UI may show Monitoring unavailable until the backend routes are deployed. Do not restart llama.cpp or tasks for this feature. Validate desktop/mobile layout, both themes, session expiry and read-only observations in the deployed Admin page. Inference metrics stay unavailable unless a later, separately approved backend configuration enables them. No production restart controls are added by Phase 1.
