# MP-04B.1A context telemetry review

## Findings and behavior

The previous normalizers intentionally left context null to avoid representing
prompt/cache/output sums as measured occupancy. The browser also explicitly
cleared legacy context fields. This patch adds independently nullable
contextUsedTokens and contextCapacityTokens, rendered through one shared helper.
The existing generated/prompt/cache counts, durations and speeds are unchanged.

For llama.cpp, GET /props exposes default_generation_settings.n_ctx as slot
capacity. It is not divided by total_slots, multiplied by parallelism, or replaced
with model n_ctx_train. A concurrent GET /v1/models must return exactly one model
whose ID matches the requested model. Ambiguous router results or alias mismatch
leave capacity unknown. No backend settings or slot assignments are changed.

For Ollama, GET /api/ps provides context_length for loaded models. Only one exact
model/name match is accepted. Training metadata from /api/show is not used.
Native request options.num_ctx could explicitly set allocation, but the current
adapter does not send it; this patch does not introduce an override or treat
provider contextLimit metadata as proven runtime allocation.

Neither inspected chat contract establishes final context occupancy. Prompt
counters describe prompt evaluation, not the full current KV state after output,
truncation or shifting. Slot polling cannot safely attribute occupancy to this
request without a correlated task identity, so it is not used. Consequently
contextUsedTokens remains null for these providers. The renderer supports a
future directly measured usage value without estimating one now.

References:
- https://github.com/ggml-org/llama.cpp/blob/b11609/tools/server/README.md
- https://docs.ollama.com/api/ps
- https://docs.ollama.com/api/chat

## Security and reliability

One final observation per completed request: one GET for Ollama, two concurrent
GETs for llama.cpp. Shared 1.5-second timeout, request cancellation, existing
credential resolver, same configured origin/proxy prefix, redirects forbidden,
256 KiB response limits. Errors return unknown capacity without failing successful
text generation. No polling/cache, arbitrary resources, credentials in telemetry,
or discovery-related process changes. Final completion may wait up to the
observation timeout. Runtime restart/reallocation during observation remains a
live-acceptance limitation: capacity is the observed allocation, not an atomic
historical guarantee across an external restart. Tool mode records final-call
capacity, not a combined tool-loop measurement.

## Persistence and display

Both new fields persist in existing message telemetry JSON. Restoration uses
only that snapshot, never current provider state. Old contextTokens/contextLimit
estimates are not converted to measurements or rewritten in SQLite. Historical
messages without new fields display Context: N/A.

Supported illustrative output, not a live reading:
`Generated: 173 • 37.4 t/s • 4.59 s | Context: N/A / 32,768 • Cached: 2,677 • Prompt: 11`

The generic renderer also supports usage-only and used/capacity pairs if reliable
measurements become available. No percentages, bars, colors or new panels.

## Validation / controlled acceptance

363-test baseline; 370 tests pass after changes. Five changed application modules
pass syntax checks; git diff --check passes. Tests use synthetic provider responses
and actual mocked frontend functions, not live-provider or browser validation.
No production database, credentials, configuration or services were modified.

After separate deployment approval:
1. Follow the existing controlled Node deployment process without changing either
   inference provider or model settings.
2. Use an authorized test conversation and one short request per provider.
3. Inspect sanitized final telemetry and independently compare capacity with the
   matching /props + /v1/models or /api/ps observation. Do not disclose headers.
4. Confirm usage is N/A, capacity is formatted with commas, and existing metrics
   still display. Refresh and switch providers: old snapshots must stay fixed.
5. Test missing/denied optional endpoints and cancellation with an isolated proxy
   or fixture, not by stopping production. Text must still complete when optional
   telemetry fails, and unknown fields must stay N/A.
6. Check desktop/mobile wrapping in a real browser; this has not been performed.

Rollback only this task's context telemetry edits and new tests/notes; preserve
earlier uncommitted work. Existing JSON telemetry accepts additive fields, so no
schema migration or historical rewrite is required. Any deployed rollback needs
a separately authorized application restart.
