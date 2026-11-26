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
