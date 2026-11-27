# MP-08D.3A: temporary vision execution override

Only a final user message containing an owned, persisted, bound image can trigger
automatic routing. The user's stored routing preference must be enabled. Earlier
images in history do not trigger automatic selection for a new text-only message.
Manual routing and text-only requests keep their existing paths.

## Operator cost policy (required before activation)

Set `CHATBOT_ROUTING_FREE_PROVIDERS` to a comma-separated list of registered provider
IDs explicitly reviewed as non-billable. Default is empty/fail-closed. This is an
operator attestation, not a user setting or a cost inference from an endpoint/model
name. Only Ollama adapters on this allowlist can automatically execute images.
No cloud approval is granted, no cloud inference occurs, and no production
environment/configuration was changed by implementation. A selected manual vision
provider still works with routing disabled.

Selection reads the existing registry and per-user preferences, resolves approved
models, checks `/api/tags` through the existing authenticated transport, and reads
capabilities through existing bounded discovery. A 15-second selection deadline
and existing discovery caching apply. No image is sent during these checks.
Missing/unsupported/stale vision or text metadata does not qualify. Configuration,
session and preferences are rechecked before inference. Skills retain their existing
activation checks; image-plus-tools remains rejected.

The router evaluates vision priorities then the current selection. An unavailable
first choice may fall back only under `next-eligible`. `ask` returns
`VISION_FALLBACK_CONFIRMATION_REQUIRED`; `never` returns `VISION_FALLBACK_DISABLED`.
There is no confirmation bypass token or dialog in this milestone. Users must review
preferences or disable routing and choose a manual model. Removed priorities are
retained for decision ordering so they cannot silently bypass fallback consent.

The image picker can show `Image (automatic vision)` when the server finds an eligible
candidate; the selected model's capability badges still describe that selected model.
Upload and inference recheck eligibility independently; the picker is not authority.

## Persistence and retry safety

The existing image message binding is validated before routing and again in a SQLite
transaction. One assistant reservation uses existing `response_request_id` with a
`vision:<user-message-id>` key and the existing unique index. Reservation begins with
`interrupted` status, so abrupt termination does not imply a completed answer.
Successful streams save text, normalized telemetry and actual execution model/provider
in the same conversation. Failed/cancelled attempts preserve partial text and status.
`X-Chat-Persistence: server` prevents normal browser code from saving a duplicate.
The same image message cannot start a second attempt, including after restart. Retry
of a failed reserved attempt is deliberately refused; reload and make a new explicit
message if another generation is wanted. There are no automatic inference retries.

The conversation model and saved user preferences are never rewritten. Actual provider
and model use existing response headers and message telemetry labels. Unsupported
post-task preferences produce a shared informational notification explaining that the
default is preserved. Persistent switching and post-task dialogs remain MP-08D.3B.

No new schema or migration. MP-08D.2's existing routing_preferences column must already
be activated through the normal startup mechanism before using this feature.
Production services and data were untouched. Mocked transport tests are not live
image recognition or authenticated desktop/mobile GUI acceptance; both remain unverified.
