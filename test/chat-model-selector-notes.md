# MP-04B.1 review and acceptance

## Contract

Authenticated GET `/api/ai/models` returns a whitelisted catalog: provider ID,
display name, configured model ID, friendly basename, capabilities and context
limit. Endpoint addresses and credential references are excluded. All currently
enabled configured chat connections are available to authenticated users, matching
the existing shared-provider authorization model. There are no per-user provider
ACLs in the current registry.

Only configured models with streaming capability are listed. Discovery's model
IDs alone do not establish chat capability; discovered embedding/unknown models
are not automatically exposed. This version supports one approved model per
named connection. To offer another model, an administrator must configure another
connection. The selector does not load/unload a fixed llama.cpp model or change
its process configuration.

POST `/api/chat` accepts optional `selection:{providerId,model}`. The server
validates both against current enabled configuration and clones the selected
connection. Disabled, removed or mismatched choices return HTTP 400 with
MODEL_SELECTION_UNAVAILABLE. Omitting selection preserves default routing.
Legacy local selection is exposed only while it is the configured default.

The frontend captures the pair before its first await. Changing selection during
generation affects the next request, never the current one. Response headers
identify the provider and model actually routed by the server. Those labels are
stored in existing telemetry JSON and restored with the assistant message;
neither labels nor telemetry are added to subsequent model prompts. This is
routing identity, not independent proof of which weights a remote endpoint loads.

## Persistence and migration

Existing authenticated `/api/settings` and `user_settings` store modelSelection.
The existing transactional schema initializer adds nullable TEXT model_selection
once. Old users start with null (application default); chats/messages are unchanged.
Tests use in-memory databases. Production SQLite was not opened or migrated.
Deployment will run this additive migration, so the existing database backup and
controlled startup review must precede deployment. An older binary can ignore
the additional column; do not drop it during rollback.

Unavailable saved choices remain visible and are rejected server-side rather
than silently falling back. A stale choice can leave a user message saved before
the inference request fails, consistent with the existing save-before-inference
workflow; it does not delete or rewrite history. Provider outage errors retain
the existing sanitized handling.

## Validation and limits

363 tests pass (baseline 354), including catalog filtering, invalid/disabled
selection, immutable routing, SQLite settings persistence, session replacement,
mocked selector DOM, generation switching and existing Ollama/llama.cpp suites.
Six changed application JavaScript files pass syntax checks; git diff --check
passes. Mocked DOM tests are not real-browser desktop/mobile acceptance.
No dependencies, production changes, service restarts, commits or pushes.

## Controlled live acceptance — not executed

1. Review the patch and additive migration; obtain separate deployment approval
   and follow the existing Node-only controlled deployment/rollback procedure.
2. Log in with an authorized test user. Check grouped choices on desktop and
   mobile, keyboard selection, wrapping and the active selection label.
3. Select each existing configured provider in turn; send one short request in a
   test conversation. Verify unchanged streaming/statistics and provider/model
   label. Switching must retain all prior messages.
4. Refresh and verify selection and per-message labels restore. Log out and sign
   in as another test user; confirm selection isolation.
5. Switch choices during a bounded generation and verify its original route,
   then cancel another request and verify existing cancellation behavior.
6. Test removed/disabled/stale selections only in an isolated configuration;
   confirm rejection, no automatic model substitution, and preserved history.

Rollback selectively removes this task's source edits while preserving preceding
uncommitted work. Retain the additive nullable DB column and existing message
telemetry. Do not use a broad git restore or rewrite production conversations.
