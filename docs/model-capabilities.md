# MP-08A.1 metadata-only discovery

Admin AI Providers includes a Model Capabilities section in the existing editor.
Select a saved model and Refresh Capabilities. Unsaved edits are not inspected.
POST `/api/admin/ai/connections/:id/capabilities` accepts `{ "model": "saved-id" }`.
It uses existing administrator/session and same-origin guards, rechecks the session
and configuration revision after collection, and returns no raw metadata or secrets.

Existing provider records remain in the connection JSON store (`core/connections.js`).
No second registry, SQLite migration or persistent capability fields are introduced.
Results retain per-capability state, method, scope and verification time in a bounded
100-entry process-memory cache, reused for 15 seconds. Restart discards this cache;
the UI requires refresh after reopening. At most four collections run concurrently.

Ollama POST `/api/show` reads its declared capabilities: completion, vision and tools.
An explicit nonempty declaration marks omitted capabilities unsupported; missing or
malformed declarations remain unknown. This does not download or load a model.
llama.cpp GET `/props` accepts explicit boolean `modalities.vision` only when its
model_alias/model_path matches the selected identity (including the existing explicit
default-model mapping). Text/tools remain unknown without reliable declarations.
Other adapters return unknown without requesting credentials or sending network traffic.

`verified` means metadata-declared, not an inference compatibility test. Discovery
never changes existing boolean capability settings or routing. `documents` is
separately scoped to the application's existing document-to-text attachment pipeline;
it does not assert native document understanding, OCR or successful inference.

Transport reuses provider authentication and DNS/address restrictions; redirects are
rejected. Metadata collection has a five-second deadline and a 1 MiB response cap.
Errors are sanitized and shown through shared popup notifications. No inference,
tool execution, model pulling, lifecycle operation or production configuration write.

Protocol references: https://github.com/ollama/ollama/blob/main/docs/api.md
and https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp
(`get_res_props`, explicit modalities). Backend versions may omit these fields.
Focused mocked tests do not establish live provider or real-browser acceptance.

## MP-08A.2 Chat presentation

The existing model selector retrieves authenticated GET `/api/ai/capabilities`
with `providerId` and `model` query parameters after load or model changes, including
Application default. Only enabled, approved chat selections under existing provider
gates are allowed. This endpoint reads recent MP-08A.1 observations, never credentials
or provider endpoints. Unknown is returned until an administrator refreshes metadata
in the same server process. Results expire after five minutes; configuration changes
and failed refresh invalidate them. Results do not establish current reachability.

Only capability states, fixed methods, timestamps, selected IDs and image-path
availability reach the browser; no browser persistence is added. Late responses,
logout, expiry and failures clear image allowance. Text requests and tools are
unchanged; tool verification is informational, not authorization.

The composer shows Text, Vision, Documents (app), Tools and an image affordance.
The existing picker permits images only for verified vision plus the configured
adapter's existing image path. No upload implementation or formats are added.
Unverified images are excluded from the picker and refused before the existing
upload step; a selected image is cleared when allowance is lost. TXT/PDF/DOCX
handling is preserved. Theme tokens, wrapping and a mobile breakpoint are reused.

Validation: focused mocked endpoint, selector and capability tests cover authorization,
model switching, unavailable/stale metadata and image-path gating. Real authenticated
desktop/mobile acceptance remains unverified: the browser connector was unavailable
and the native helper reported the Chrome window minimized. No production restart
or live capability refresh was performed for this milestone.
