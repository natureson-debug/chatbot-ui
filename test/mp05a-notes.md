# MP-05A: provider configuration and model management

Configuration-only delivery. No production configuration, credentials, services or databases were changed. Native OpenAI Responses, Anthropic Messages and Gemini generation remain explicitly unavailable until MP-05B/C/D. Their configured models are excluded from chat selection. Compatible presets reuse the existing generic adapter; provider-specific exceptions and live qualification remain MP-05E. Cost tracking remains MP-05F.

## Configuration contract

The existing version-1 connection store and optimistic revision writes remain authoritative. Optional `providerType` selects a preset; it must agree with `adapter`. Endpoints remain editable. No model IDs are hardcoded. Existing connections without the new fields retain their single-model behavior.

Optional `models` contains 1-100 entries: `id`, friendly `name`, `enabled`, administrator-approved `chat`, supported `parameters` (`temperature`, `max_tokens`), numeric `defaults`, and optional boolean `capabilities` (`thinking`, `vision`, `tools`). The connection's existing `model` selects its default and must be enabled and chat-approved. Explicit request parameters override model defaults. Unsupported parameters are not forwarded. Discovery never approves models or replaces configured lists; discovery failure preserves them. Discovery is bounded to the first response page and 200 identifiers; manual IDs remain supported. The existing 32 KiB Admin save limit still applies.

Per-model selection is cloned before use. Connection-level runtime context and backend identity mappings apply only to the connection's default model, preventing telemetry association with a different selected model. Historical message statistics are unchanged.

## Credentials and transport

The UI accepts server-provisioned `env:CHATBOT_*` references, not actual key values. Existing local-key references remain supported for local connections. Replacing a reference changes which server environment variable is used; removing it disables authentication for that connection. This does not delete or provision environment variables. Existing secret values are never sent to the browser or saved in connection JSON. Inline API-key/password/header fields are rejected. Admin routes retain authorization and same-origin mutation checks, and configuration/discovery reads recheck sessions after asynchronous work.

Cloud presets require public HTTPS, with normal certificate validation. DNS results are checked and the checked address is pinned to the socket while preserving the hostname for TLS. Redirects and metadata addresses are rejected. Existing explicit loopback/private-network permissions remain available for local/custom providers; private DNS answers require approval. No automatic HTTP proxy discovery or provider-specific proxy compatibility is claimed. Requests have cancellation and bounded deadlines; no retries are introduced.

Official preset references: [OpenAI Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Anthropic models](https://platform.claude.com/docs/en/api/models/list), [Gemini models](https://ai.google.dev/api/models), [DeepSeek](https://api-docs.deepseek.com/guides/codex), [Groq](https://console.groq.com/docs/api-reference), [Mistral](https://docs.mistral.ai/api), [OpenRouter](https://openrouter.ai/docs/api_reference/overview), [xAI](https://docs.x.ai/developers/rest-api-reference/inference/responses). These document endpoint defaults/protocols, not evidence of live qualification.

## Validation and acceptance

Automated tests use temporary configuration stores and injected HTTP/DNS fixtures only. They cover presets, multiple models/accounts, credential references, malformed configuration, approvals, native-generation gates, discovery, authorization/session revocation, DNS rebinding, private addresses, redirects and cancellation. No live cloud calls or paid inference were performed. Existing local, Ollama, streaming, telemetry and persistence suites are included in the full test run.

After separate deployment approval: verify existing llama.cpp/Ollama chat behavior; create a disposable connection with a securely provisioned reference; check preset defaults and discovery; manually approve models and select a default; save/reload and verify friendly names and parameters. Native pending providers must remain absent from chat selection. Browser layout and provider-specific live behavior still require acceptance. Do not send billable inference without approval.

## Rollback

Revert only the MP-05A changes, preserving unrelated uncommitted work. No migration is required. Before a later deployment/configuration edit, preserve the then-current connection JSON through the established backup procedure. If rolling back after adding native protocols or multiple models, restore that compatible configuration snapshot as well: old readers do not understand native adapter types and can discard unfamiliar fields. No production rollback action was performed here.
