# Admin Benchmarking

The Admin Console Benchmark tab runs bounded, serial streaming requests through
the configured local llama.cpp client. It has no arbitrary URL or command
input, and it does not change server settings, restart the backend, or require
the Prometheus `/metrics` endpoint.

## Safety and execution

- Every route requires a current administrator session. Results and exports are
  also session-revalidated before return.
- Only one queued/running run is allowed by a SQLite unique partial index and
  the in-process runner.
- The runner checks authenticated `/slots` before starting and before every
  request. Missing, malformed, or unsupported busy-state information refuses
  execution. A bounded idle wait is used between repetitions.
- A normal `/api/chat` request preempts and cancels the benchmark request before
  ordinary inference continues. Cancellation aborts only the benchmark HTTP
  request; it never terminates llama.cpp.
- Limits are 32–2,048 prompt target tokens, 1–1,024 output tokens, 1–20
  measurement repetitions, 0–5 warm-ups, concurrency 1, and 1–120 seconds per
  request. The bounded prompt is deterministic and contains no user content.
- Prompts, generated responses, API keys, and raw upstream errors are not
  persisted. Only configuration, sanitized run metadata, and measurements are
  stored.

## Measurements

Input/output token counts come from server-reported completion usage and remain
unavailable when usage is absent. Prompt processing speed is recorded only
when the individual response provides prompt timing data; otherwise it is
`null`. Time to first token is measured end-to-end to the first non-empty
streamed content. Output tokens per second is explicitly end-to-end
output-throughput (`completion tokens / full request duration`), not internal
decode speed.

Model ID is observed from the local model endpoint. GPU name/driver/UUID are
included when the existing telemetry sampler can provide them. Missing values
are shown as unavailable. CSV and JSON exports are offered only for completed
runs.

## Database additions

Normal application schema initialization adds `llm_benchmarks`,
`llm_benchmark_runs`, and `llm_benchmark_results`, plus run/result indexes and
a unique active-run index. These are additive; existing user, session, chat,
message, provider, and system-log data are not rewritten. Existing queued or
running benchmark rows found at backend startup are marked failed as
`interrupted_by_restart`; no benchmark is resumed or started automatically.

Activation requires reviewing the application migration and allowing the
normal Node startup path to apply the additive schema. No benchmark was run
against the production inference server during implementation.

## Analytics and reporting (MP-05F.5B)

Analytics uses saved repetition records only; viewing/comparing/exporting never executes
inference. Select a metric and two to six historical runs from the latest 50 saved runs.
All individual results are displayed, including warm-ups and failed/cancelled attempts.
Average and median references exclude warm-ups and non-successful measurements. Each
metric independently excludes unavailable/invalid samples. Missing values are not zeros.

Output throughput is output token count divided by client-observed end-to-end duration,
including prompt/network overhead. It is not server decode speed. TTFT measures arrival
of the first nonempty content delta (potentially several tokens), not first internal token.
Prompt throughput uses server prompt timing only. No new timing measurements are inferred.
Historical context configuration was not captured reliably and remains unavailable.
Comparisons warn about differing workload settings, model tokenizers and unknown context.
Token totals in comparison include all measured attempts with known usage; any unknown
usage makes the total unavailable. Failure/cancellation counts remain separate.

Existing CSV/JSON contracts remain intact. Completed runs can also be exported as XLSX
or PDF through the same administrator-authenticated and revalidated export route.
XLSX stores text as inline strings (never formulas) and preserves Unicode. It contains
configuration, metadata, summaries and all measurements; charts are available in the UI
and PDF rather than embedded in Excel. PDF includes four vector charts and paginated
measurement details. The minimal PDF writer uses a built-in font and represents non-ASCII
labels as reversible Unicode escapes; use Excel/JSON for native Unicode labels. These
are reports, not live dashboards; snapshots do not update after download.

No schema or execution-policy change is needed. JSZip 3.10.2 was already installed via
Mammoth and is now an explicit pinned dependency; no additional package installation.
Rollback: restore only the reviewed MP-05F.5B source changes, preserving earlier changes
and all databases. Backend deployment/restart remains separately authorized. Browser
layout and office-application acceptance require controlled acceptance after deployment.
