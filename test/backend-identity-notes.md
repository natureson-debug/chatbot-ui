# MP-04B.1A.3 — explicit backend identity

## Schema and behavior

Provider configuration version 1 gains optional `backendModelIdentity` for
llama.cpp only. It is an exact string (1–4096 characters, non-whitespace, no control
characters), not a filename to open or a URL to fetch. Missing/null retains the
previous exact-match behavior using `model`. No automatic alias inference,
case folding, basename matching or trimming is applied to a supplied identity.
Other adapters reject a non-null mapping. No production config was edited.

The existing provider name and chat selector labels remain presentation data.
`model` remains the inference request identifier. `backendModelIdentity` is only
the expected backend-advertised identity for capacity verification; it is never
sent as the generation model or included in the ordinary-user model catalog.

Admin Console → AI Providers → Edit now has an optional Backend model identity
field. Save uses the existing authenticated admin API, revision check and atomic
JSON store. Blank removes the mapping. Switching to a non-llama provider requires
clearing it. Discovery never silently populates it.

Intended explicit edit after review (not applied): retain `model: "qwen:latest"`
and set `backendModelIdentity` to the exact GGUF identity already verified by the
operator. For the reported installation this is:
`C:\AI\models\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf`.

Capacity still requires a positive safe-integer `default_generation_settings.n_ctx`
and an exact identity match. It remains per-slot capacity, independent of
total_slots. Explicit /props identity disagreement fails closed even if discovery
elsewhere matches. Responses without identity retain the existing single-model
discovery fallback. Actual occupancy remains unknown; snapshots and Ollama are
unchanged. Identity strings do not prove model file hash/integrity or detect a
replacement that deliberately reuses the same advertised identity.

## Validation and deployment

380 tests passed, zero failures (375 before this task). New tests exercise schema
compatibility, temporary-file persistence/removal, mapped request-to-metrics
behavior, model replacement, mismatches, missing mapping, invalid capacity and
actual Admin form collection with mocked DOM. Existing Ollama and historical
statistics tests pass. Changed JavaScript syntax and git diff --check pass.
No production database, services, credentials or settings were changed.

Controlled acceptance after separately approved deployment:
1. Review the mapping against authenticated /props and /v1/models of the intended
   backend; do not copy identity from another provider.
2. Edit only Backend model identity for the existing llama.cpp connection. Keep
   friendly/request model, endpoint, authentication and GPU settings unchanged.
3. Save and reopen the form to confirm exact persistence.
4. Generate one short authorized test response. Confirm request model remains
   qwen:latest and Context displays N/A / 32,768 for the confirmed runtime.
5. Refresh and switch providers: historical snapshots must remain fixed and
   Ollama metrics unchanged. Exercise replacement/mismatch only with fixtures.

Rollback: clear the optional mapping through the same reviewed Admin workflow,
then selectively revert this task's source/test edits if needed. Do not broadly
restore the working tree or rewrite historical telemetry. No schema migration is
needed; older source ignores the optional provider property and may drop it on a
subsequent configuration save. Any deployed source rollback needs separate
approval for the controlled application restart.
