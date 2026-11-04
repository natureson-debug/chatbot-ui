# MP-04A.3 diagnosis and acceptance

Confirmed source defects: named connections can report unknown context capacity,
but the old browser renderer required non-null capacity AND every timing field
before displaying anything. It ignored usage-only events. The adapter passed
raw SSE unchanged. The non-streaming tool adapter discarded response-level
usage/timings and the HTTP tool branch emitted only content.

HEAD's previous renderer also required all timing fields, but did not have the
new context-capacity gate. It calculated context from cache + prompt + generated
tokens. That calculation is deliberately removed under MP-04A.3's no-estimates
requirement. The b11609 OpenAI chat response does not expose directly measured
context occupancy: Context therefore remains N/A. No extra slot polling or
model/GPU configuration changes are introduced.

The adapter now requests `stream_options.include_usage` for llama.cpp and
normalizes OpenAI SSE timing/usage events before the existing byte-forwarding
HTTP route. Usage-only events with empty choices are accepted. Unknown individual
values remain null. Prompt/cache/output counts are validated independently;
milliseconds convert to seconds. Speed can be calculated from measured output
count and duration when the backend does not supply it. Model aliases are passed
unchanged and are never used to select the metrics parser.

Upstream b11609 implementation attaches timings when available and emits the
extra usage event when include_usage is enabled:
https://github.com/ggml-org/llama.cpp/blob/b11609/tools/server/server-task.cpp
(to_json_oaicompat_chat_stream).

Tool-mode metrics represent only the final completion call, not all tool rounds.
Ollama native streaming and discovery remain unchanged. The shared UI consumes
normalized telemetry only; unavailable metrics are N/A. Existing historical
telemetry remains readable, but old saved estimates are not rewritten.

Validation: baseline 347 passing tests; current 354 passing. Syntax checks and
git diff --check pass. Tests use synthetic streams and mocked frontend execution,
not production generation or real-browser acceptance.

Controlled live acceptance (not performed):
1. Review this patch and authorize deployment through the existing controlled
   Node restart procedure; preserve all unrelated uncommitted work. Do not
   restart inference, change provider settings or modify credentials.
2. In an authorized test conversation, choose the existing llama.cpp connection
   and send one short ordinary streaming request with tools disabled.
3. Inspect only sanitized SSE statistics: final timings/usage, normalized
   telemetry and DONE. Verify alias remains unchanged, partial values display,
   missing cache/context show N/A, and restored chat retains the same metrics.
4. Cancel one separate bounded request and confirm partial output survives,
   cancellation propagates, and no prior message's statistics are reused.
5. Repeat a short ordinary request on the existing Ollama connection to confirm
   native metrics and display remain unchanged. Tool mode, if tested separately,
   must be assessed as final-call metrics only.
6. If the backend supplies no timings, capture only sanitized field names and
   version evidence. Do not infer a GPU or model problem from missing metrics.

Rollback: selectively revert MP-04A.3 changes, preserving earlier work, then
use a separately authorized application deployment. No data/config migration.
