# MP-05C.3 — DeepSeek GUI configuration

Baseline: 54cabd1 on feature/mp-05c-deepseek. No production service restart, database operation, existing credential change or live inference performed.

## Administrator workflow after approved deployment

Open the existing HTTPS Admin Console, then AI Providers. Add a DeepSeek provider, give it a stable ID, review endpoint and approved models, and save it disabled. Edit it, enter its key in the password field and explicitly Save API key. The field clears; only Configured/Not configured returns. Enable the independent DeepSeek safeguards switch, then use Test Connection after confirming paid usage. Enable the provider and select it in chat. Editing models, display names and defaults uses the existing registry. The requested initial suggestions are deepseek-chat and deepseek-reasoner; account availability is not verified or guaranteed. No model name is embedded in inference routing.

Stream DeepSeek output controls upstream streaming; disabling it uses a bounded non-streaming Chat Completions response translated to the existing browser event contract. No tools or reasoning are exposed. Keys can be replaced or deleted. Deleting disables the provider first. Changing provider ID or endpoint invalidates credential binding and requires explicitly saving the key again. Status does not imply credential validity at the vendor.

## Storage and authorization

`protected:<provider-id>` resolves server-side to an encrypted file under the configured application home's config/protected-credentials directory. Windows DPAPI CurrentUser protects the bytes, with provider ID and endpoint as binding entropy. No plaintext key or wrapping key is stored in SQLite, config JSON, logs, command arguments, browser storage or cookies. The existing environment-reference mechanism remains available. The helper uses an absolute Windows PowerShell path, a constant encoded script, private stdin/stdout pipes, no shell, an 8-second deadline and bounded output; errors are sanitized. This is Windows-only and fails closed if DPAPI/user profile is unavailable. It cannot protect against administrators or malicious code already running as the same Windows account. Node and trusted application code must be protected appropriately.

Ciphertext writes are temporary-file/atomic-rename, and administrators' original sessions are rechecked after body parsing and before committing. Credential endpoints require administrator access and same-origin intent for mutations. A write already submitted cannot be rolled back by later logout. Concurrent credential/test operations for the same provider are rejected in the current single-process deployment. There is no multi-worker claim. Public configuration exposes only the reference, never the key.

GUI-protected DeepSeek connections do not require CHATBOT_DEEPSEEK_ENABLED: they still require provider enablement, approved models, readable protected credential and the independent administrator safeguards switch. Environment-reference DeepSeek connections retain their existing environment gate; OpenAI is unchanged. Enabling a protected provider fails if its key cannot be decrypted. A key subsequently lost or made unreadable fails before outbound dispatch.

## Paid connection test

POST to the administrator's saved-provider test endpoint requires confirmPaidTest=true. It uses saved credentials and an approved model, a fixed synthetic prompt, at most 16 generated tokens, an 8-second adapter timeout and 10-second outer deadline. No retries. Existing DeepSeek request/concurrency limits and durable usage accounting apply; no chat-history rows are created. The response contains only success, upstream HTTP status when available, model, elapsed time, normalized usage, terminal status and a sanitized error. No generated text or raw provider error is returned. The switch and session are checked immediately before dispatch and again after DNS through the existing secure transport.

## Qualification and deployment limits

Automated tests use disposable databases, mocked transport and synthetic credentials. An additional real Windows DPAPI test exercised encrypted save, reopen, replacement, endpoint mismatch and deletion outside the restricted sandbox; all temporary files were removed. The restricted sandbox itself cannot access the operator DPAPI profile, which is not a plaintext-fallback justification. Deployment must retain the same Windows account/profile and verify that protected storage is writable/readable by that account. Back up encrypted blobs with the account's recovery plan; copying ciphertext to a different account is not sufficient recovery.

Real browser desktop/mobile acceptance and live model testing remain unverified. Existing responsive form classes are reused; no second DeepSeek configuration panel or dashboard is introduced. A controlled restart/deployment and production migration remain separate approvals. To roll back, disable DeepSeek, restore the previous code/configuration, and retain encrypted blobs safely; older code cannot resolve protected references. Never silently convert them to plaintext or enable the old environment-based path.
