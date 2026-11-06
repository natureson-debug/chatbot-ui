# MP-07.2B-2C-2 credential service contract

`createCredentialService({backends, authorize})` exports `status(reference, context)`,
`resolve(reference, context)`, `replace(reference, secret, context)` and
`remove(reference, context)`. This module is not imported by application consumers.
It has no default backend, environment lookup, file access, logging or DPAPI call.

Results contain only `status` and a stable `code`, except successful `resolve`,
which additionally returns `secret` to the authorized server caller. Never serialize
that result into HTTP responses or logs. Authorization defaults to denial and is
rechecked after asynchronous backend work. The trusted server-supplied callback
receives `(operation, frozenDescriptor, context)`; context is not an authorization
credential by itself. Bind it to the real authenticated session and permitted
consumer. Backend and authorization implementations are trusted code, not plugins
or user-supplied request objects.

Codes: CREDENTIAL_AVAILABLE, CREDENTIAL_MISSING, CREDENTIAL_INACCESSIBLE (including
locked), CREDENTIAL_UNDECRYPTABLE, CREDENTIAL_UNSUPPORTED_PLATFORM,
CREDENTIAL_INVALID_REFERENCE, CREDENTIAL_ACCESS_DENIED, CREDENTIAL_INVALID_SECRET,
CREDENTIAL_BACKEND_FAILURE, CREDENTIAL_REMOVED. Unexpected exceptions and malformed
results become BACKEND_FAILURE without forwarding message, cause, path or output.
Backend adapters must explicitly classify known failures; this contract does not
guess decryption failures from exception text. Removing a missing item returns REMOVED.

Backends implement each method as `(descriptor, secretOrUndefined, {authorize})`
and return structured status. Only resolve needs a secret result. Status must be
implemented without returning plaintext; the service discards any extra fields.
Write adapters must recheck authorize immediately before committing. A post-write
revocation cannot undo an already committed write, and the wrapper makes no such
claim. Environment implementations should be read-only (omit replace/remove);
there is no implicit environment mutation or plaintext store.

References preserve `env:CHATBOT_*`, `protected:<providerId>`,
`protected:brave-search`, and `local-api-key`. Context must contain the matching
credentialRef. DeepSeek additionally requires adapter/id/endpoint; its binding is
exactly JSON `["chatbot-deepseek-v1", id, new URL(endpoint).href]`. Brave uses
`["chatbot-brave-search-v1"]`. The local key requires the existing llama.cpp
loopback origin. None/null is not a credential reference; no-auth consumers should
skip the service. Existing network/provider validation remains a separate duty.

Inject `protected` as a future Windows DPAPI or macOS Keychain implementation,
`environment` for explicit environment references, and `legacyLocal` for existing
key-file compatibility. Backend choice must be explicit at server composition;
there is no fallback after missing/locked/decryption failures. Keychain is not
implemented, and its namespacing/binding must be qualified before integration.
No reference schema, DPAPI entropy, file location or provider gate is changed.

Replacement follows existing 4096-character, nonempty, no CR/LF/NUL validation and
trimming. Plaintext is necessarily present in memory for resolve/replace; JavaScript
strings cannot promise reliable zeroization. Status availability is point-in-time,
not a reservation. Synthetic tests use fake backends only, not real credentials.

Remaining work: wrap existing storage behind adapters; define accurate missing vs
inaccessible vs undecryptable mapping; qualify session/write guards and concurrency;
then integrate individual consumers under separate approval. Existing routes,
startup, UI, gates and persistence remain unchanged in this stage.
