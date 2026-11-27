# MP-08B.2B — one-image vision messaging

Additive migration identifier: **image_attachments-v1**, applied by the existing
`initializeSchema` transaction. The project uses idempotent schema additions, not
numbered PRAGMA user_version migrations. Existing tables/messages are not rewritten.
No production database was opened or migrated during implementation.

The table stores owner, chat/message association, UUID storage identifier, sanitized
filename, MIME, normalized bytes/dimensions, creation/expiry time and lifecycle state.
One image can bind to each user message. Binding occurs inside `createMessage`'s
transaction; invalid references roll back message insertion. Uploads reserve quota
before asynchronous decoding/storage. States: uploading → pending → bound; pending
uploads expire after one hour. Chat/message deletion nulls foreign keys, preserving
cleanup records. Cleanup transactionally claims deleting rows; binding cannot claim
those rows. Bound files cannot be deleted via either public attachment endpoint.
Deletion failures retain metadata/quota for retry. An unref'ed one-minute cleanup
timer starts with the backend; no scheduled task is used. Active in-process uploads
are excluded from cleanup. One application backend per data root is required;
concurrent independent application processes sharing attachment storage are not
qualified. Existing filesystem symlink protections and same-user TOCTOU limitations
remain applicable.

Configuration (environment, no provider changes):
- `CHATBOT_IMAGE_MAX_BYTES`: default/hard ceiling 10 MiB; may be lowered.
- `CHATBOT_IMAGE_QUOTA_BYTES`: default 100 MiB per user; maximum 1 GiB.
- 100 retained image records per user; deleting records still count until removed.
- At most two image decoders concurrently per backend.
- Dimensions: at most 8192 per axis and 16 million pixels.
- One image per user message; inference history bounded to four images / 20 MiB.

Quotas account for normalized binary bytes, with a maximum-size reservation during
upload; on-disk JSON/base64 incurs additional overhead. Files remain in the existing
per-user attachment store. PNG/JPEG/WebP signatures and header dimensions are checked
before native decoding in a timed worker, then decoded dimensions are checked and
pixels re-encoded to PNG. Metadata and original compressed bytes are not retained.
`@napi-rs/canvas` 1.1.0 was already installed transitively; it is now pinned directly
without upgrading/installing packages. Native decoder security is still a dependency;
worker memory limits are not an OS sandbox or a native-allocation hard limit.

POST `/api/images` uses existing session and same-origin checks, conversation ownership
and server-side Ollama metadata verification. GET/DELETE `/api/images/:id` enforce owner
and lifecycle state. Upload responses contain opaque IDs, never storage paths. Message
content contains `[Chatbot image: UUID]`, not base64. Retrieval after reopening uses
authenticated thumbnails. Images pending after failed message persistence expire;
images bound before failed inference remain part of the user message.

Only Ollama image inference is qualified in this milestone. Metadata discovery may run
on demand for Chat when its observation cache expires. A request-local vision flag is
derived from verified metadata; no saved capability flag or credential is changed.
Before forwarding, every image reference must match its persisted user message and
conversation. Client-supplied multimodal arrays and legacy unbound image references
are rejected. Text-only requests and existing document processing are unchanged.
Image-plus-tool requests are explicitly rejected; no new tool behavior is introduced.

Deployment requires a separately approved Node restart and a consistent backup first.
Preserve the new table/files on rollback; an older server must not be used to manage
new image records because it lacks bound-file deletion protection. No live deployment
was performed. Desktop/mobile browser acceptance remains unverified because browser
automation was unavailable. Automated preview/layout checks are not browser acceptance.

A single live synthetic 32×32 red PNG was sent through the existing adapter to
MacMini Ollama `qwen3-vl:4b`: HTTP 200, streamed answer `red`, about 4.4 seconds.
This verifies live model image input, not the authenticated browser/upload workflow.
