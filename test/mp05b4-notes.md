# MP-05B.4 — durable response reliability and request safeguards

Production was not opened/migrated/restarted and no live provider request was made. The environment gate remains default-off; the new administrator switch also defaults off.

## Additive migration and rollback

The existing schema initializer's `BEGIN IMMEDIATE` transaction adds nullable `messages.response_status`, nullable `messages.response_request_id`, a unique non-null request-ID index, `openai_usage`, and singleton `openai_safeguards`. Existing messages stay status-unspecified; no old content is rewritten. Migration exceptions roll back the additions. Existing startup remains fail-closed on a missing/invalid database.

Disposable tests cover old schema/message migration, repeat initialization, injected migration failure and an old schema initializer reading the migrated database. Rollback is data-compatible, not feature-equivalent: older code cannot enforce these safeguards or show new status notices. Disable OpenAI before any rollback and retain status-aware rendering for affected histories; never drop tables or restore an old database over newer conversations. A production rollout requires a verified SQLite-consistent backup and explicit maintenance approval. No production migration was performed here.

## Response lifecycle

OpenAI now requires an owned `chatId` and its `expectedRevision` on `/api/chat`. The server reserves one request ID and records `in_progress` before credentials/network. Partial text is persisted synchronously before being forwarded. A single assistant row per request is updated to `completed`, `cancelled`, `failed`, `incomplete` (including output limits), or `interrupted` (timeout/network/malformed stream). Usage survives conversation clear/delete, but late output cannot recreate deleted or cleared messages.

`X-Chat-Persistence: server` tells the updated frontend not to POST the assistant message again. It retains local display/telemetry and restores `responseStatus` separately from text. Existing llama.cpp/Ollama saves and legacy unspecified-status messages retain their old behavior. Older cached clients must be refreshed before enabling OpenAI: their assistant-save workflow is not server-persistence aware. This is not a generic client-retry idempotency protocol.

After a successful listener bind, startup reconciliation marks unfinished usage and related partial messages `interrupted`. An actual abrupt disposable application exit/restart tests this path. This design assumes the existing single Node application instance per database; multi-worker or multiple-port deployments sharing one database are not qualified, because startup reconciliation assumes prior owners have exited. Concurrent request admission across SQLite connections is serialized, but that does not establish multi-process startup ownership.

## Usage schema

`openai_usage`: internal UUID primary key; provider/model/user/conversation IDs; captured chat revision; start/finish epoch timestamps; status; nullable input/output/cached-input token counts; measured latency; nullable provider response ID. No key, Authorization header, prompt, or raw provider error is stored in this table. Provider response IDs never enter browser messages/history. Terminal observations are idempotent. Null usage remains unknown; zero is retained only when reported.

The table records admitted provider attempts, including missing credentials and failed/cancelled calls. Authentication/model/quota rejections before admission are not billed provider attempts and do not create usage rows. No automatic retry occurs. Records are currently retained without an automatic retention policy.

## Enforcement

Both `CHATBOT_OPENAI_RESPONSES_ENABLED=1` and the administrator switch are required. Admission uses one synchronous `BEGIN IMMEDIATE` transaction for final session validation, ownership/revision checks, gates, rolling per-user counts, concurrency and reservation. Defaults: 1024 maximum output tokens, one concurrent request, 20 requests per rolling hour and 100 per rolling 24 hours. Models must explicitly approve output-token limiting; otherwise requests fail closed. The server caps the outgoing `max_output_tokens`, independent of client values.

Authorization/gates are rechecked after credential resolution and immediately before socket creation after DNS, preventing delayed preparation from bypassing disable. Turning off the switch blocks new dispatch; it does not cancel already-dispatched requests or undo provider billing. Database/stream failures cannot silently authorize retries; unresolved reservations remain blocked until reconciliation.

Optional `estimated_daily_usd` is deliberately fail-closed: pricing/input-cost estimation is not installed, so setting a threshold blocks admission with `OPENAI_COST_UNVERIFIABLE`. Null leaves enforceable request/token controls active. No unknown price is treated as zero and no exact monetary ceiling is claimed. Live acceptance needs an independent provider-side spending policy; implementing a price estimator is separate work.

## Administration and validation

Admin-only `GET/POST /api/admin/ai/openai-usage` exposes aggregate UTC-day requests/status counts, known token totals, unknown-usage count, concurrency and settings. POST requires same-origin intent and revalidates the original administrator session after body parsing. Ordinary users cannot retrieve records or aggregates. The new Admin section uses explicit refresh, displays unavailable values as N/A and never receives secrets.

Tests use disposable SQLite (including two connections), injected transport, actual authenticated HTTP and actual frontend functions with mocked DOM. They cover migration/rollback, quota windows, gate enforcement, deduplication, output limits, disabled authorization during DNS, secret redaction, actual fixture-process crash/restart, status restoration, failure/partial/cancellation, clear/delete safety and local-provider regressions. Real browser and live OpenAI acceptance remain unverified; no billable calls occurred.
