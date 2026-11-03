# MP-05B.2 — native OpenAI Responses text streaming

Implementation only. No production configuration was changed, no service restarted and no live OpenAI requests were made.

## Gate and approvals

`CHATBOT_OPENAI_RESPONSES_ENABLED=1` is an explicit **server process environment** gate. Absent or any other value means disabled; browser input cannot enable it. Production remains disabled by default. Do not enable it as part of deployment without separate approval for live acceptance.

Selection additionally requires an enabled `openai-responses` connection, an `env:CHATBOT_*` credential reference and an explicitly enabled/chat-approved entry in `models`. Connection validation (including public HTTPS/security restrictions) runs before inference. Secret values resolve only on the server; missing/invalid values cause a safe error before transport. The catalog checks reference syntax, not whether the secret exists or whether OpenAI accepts it.

Only an approved model's explicit `parameters` allowlist is used. Native models do not inherit the connection's parameter list when their own list is absent. `max_tokens` maps to `max_output_tokens`; temperature is sent only when explicitly approved. Supported parameter declarations must be verified by the administrator for that particular model; discovery alone is not evidence of compatibility. Unsupported parameters are omitted. No production model names are embedded.

## Request and stream contract

One POST to the configured `/responses` resource uses explicit `input` text messages with system/developer/user/assistant roles, `stream:true` and `store:false`. There is no `previous_response_id`, persistent Conversations state, tool invocation, image input or automatic retry. It uses the existing authenticated provider routing and protected transport, including DNS pinning and redirect rejection.

Typed provider events are parsed with a fatal UTF-8 streaming decoder, bounded SSE buffering and output limits. Text deltas become existing `choices[0].delta.content` events. Done snapshots contribute only an un-emitted suffix; contradictory or out-of-order text fails closed. Created/in-progress and unknown events do not become browser events. Completed output emits normalized finish/usage metadata followed by exactly one `[DONE]` terminal marker. Token-limit incomplete output uses `finish_reason:length`. Failures, other incomplete responses and malformed/truncated streams emit one sanitized application error terminal instead of `[DONE]`. The browser parser surfaces that error using the existing partial-output/persistence path.

Cancellation and the connection deadline cover credential resolution, headers and stream reads. Cancelling the browser response aborts the upstream request and cancels its reader. Late headers after abort are discarded. Cancellation cannot guarantee that OpenAI performed no work or incurred no charge before receiving the disconnect. No automatic retries occur.

## Metrics and diagnostics

Reported input/output/cached-input counts map to prompt/generated/cached token fields. Missing/invalid values stay null. `totalSeconds` measures local request-to-terminal latency, not model-generation duration. Generation speed/duration and context occupancy/capacity remain unknown; input token totals are not context usage.

The optional server-only `createAdapter({onDiagnostics})` hook receives a validated response ID and measured latency at a provider terminal response. It is not serialized into SSE, headers or history; no production log sink is enabled. No raw errors, provider event objects, credentials or prompts enter diagnostics. Missing terminal responses may have no diagnostic response ID.

## Validation and limits

`test/openai-responses.test.js` injects all transport and synthetic credentials; real global fetch/HTTPS request calls fail the test process. It covers native bodies, approval and feature gates, auth failures, HTTP status mapping, malformed streams, multiple parts, UTF-8 fragmentation, duplicate terminals, cancellation, late headers, deadlines, telemetry, browser-parser interoperability and actual route authorization. Existing llama.cpp/Ollama and frontend regression suites remain part of `npm.cmd test`.

This is mocked protocol qualification, not real-browser or live-account/model acceptance. Native tools, reasoning display, vision, persistent response state, cost tracking and provider-specific model parameter discovery are outside this milestone. Anthropic/Gemini remain inference-disabled. A subsequent approved live trial must use synthetic prompts, an explicit model parameter review and a spending bound.

Protocol references: [Responses migration/input history](https://developers.openai.com/api/docs/guides/migrate-to-responses), [streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses), [typed streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).

Rollback: revert only the MP-05B.2 commit; leave unrelated work and configuration intact. No database migration or credential change is required. Merely leaving the server gate unset preserves the prior inference-disabled behavior without rollback. No deployment or rollback was executed during this task.
