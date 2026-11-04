# MP-04A.2 review notes

Ordinary Ollama chat now uses native `/api/chat`, translated from NDJSON to the
existing OpenAI-shaped SSE stream. A configured `/prefix/v1` becomes
`/prefix/api/chat`, preserving the scheme, host, port and proxy prefix. Discovery
and the existing non-streaming tool loop retain their OpenAI-compatible paths.
Proxies must expose the native endpoint; failures do not trigger a second request
or automatic fallback. No connection configuration is rewritten.

Authentication still uses the existing server-side credential resolver. Redirects
remain prohibited, and existing connection URL validation, request cancellation
and configured timeouts remain in force. Image messages are converted to native
base64 `images`. Thinking remains disabled for this adapter, as before.

Final native metrics normalize into the existing persisted telemetry fields:

| Native field | Telemetry |
| --- | --- |
| eval_count | generatedTokens |
| eval_duration / 1e9 | generationSeconds |
| eval_count / generationSeconds | generationSpeed (only positive duration) |
| prompt_eval_count | promptTokens |
| prompt_eval_cached_count | cachedTokens, only when supplied |
| prompt_eval_duration / 1e9 | promptSeconds |
| total_duration / 1e9 | totalSeconds |
| load_duration / 1e9 | loadSeconds |

Context occupancy and capacity remain null: prompt plus generated tokens is not
treated as actual context usage. Missing, negative, unsafe or nonnumeric native
statistics become null. The existing UI shows N/A; auxiliary durations are
preserved in telemetry rather than adding another dashboard. Native timings
arrive only at completion, so interrupted streams may have no statistics.

Synthetic example (not a live measurement):
`Generated: 40 • 20.0 t/s • 2.00 s | Context: N/A • Cached: N/A • Prompt: 100`

Sources: https://docs.ollama.com/api/chat and https://docs.ollama.com/api/usage.
Existing llama.cpp timings and formatting are unchanged. Tool-loop completions
continue using the existing non-streaming API and do not gain these native
metrics in this patch. No new dependencies or production changes.

Validation: isolated fake upstream streams, real adapter and frontend functions;
not live-provider or browser acceptance. Before deployment, qualify native proxy
routing, model support and cancellation against the intended Ollama version.

Rollback: revert only MP-04A.2 edits in provider-adapter.js and public/app.js,
restore the prior Ollama test expectations, and remove ollama-stream.js and the
new metrics tests/notes. Preserve all earlier uncommitted work; do not use a broad
git restore. No data/configuration migration is required. Any deployed rollback
would require a separately authorized application restart.
