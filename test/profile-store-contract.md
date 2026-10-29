# Task 27.16 — TEST durable AI revisions

## Scope and architecture

Only new test/support/profile-store.cjs, test/profile-store.test.js and this document. No changes to production config, paths, API, supervisor or database. Fixtures create a unique chatbot-profile-test-* directory directly under os.tmpdir(); store refuses other locations. Never imports db.js/auth.js; uses installed Node DatabaseSync directly. Fixture executables and GGUF bytes are inert synthetic files, never executed. Cleanup removes only each verified fixture root.

Current API writes mutable {model,parallel,contextSize} JSON with no CAS/revision. The existing supervisor compares fixed compiled profiles and dependency hashes and remains qualification-gated. This experiment is not a migration of either system. Explicit core/llama-launch.js validation is reused without calling its filesystem-backed default wrapper.

## Schema / API

SQLite revisions(revision INTEGER PRIMARY KEY CHECK(revision>=0), profile TEXT NOT NULL, digest TEXT NOT NULL, parent TEXT NOT NULL, seal TEXT NOT NULL).

Rows are append-only; UPDATE/DELETE triggers reject mutations. Revision 0 is first accepted config; null expectedRevision is allowed only for the empty store. Each subsequent revision is previous+1, safe-integer checked. Historical rows remain readable. There is no mutable current pointer: highest verified contiguous revision is current.

append({expectedRevision,profileId}) uses BEGIN IMMEDIATE, verifies complete history, compares current revision, validates approved artifacts and inserts one row, then COMMIT. Missing/stale revision or SQLite busy fails rather than overwriting; no retries. DELETE journal mode and synchronous=FULL provide SQLite transaction recovery. Failure-injection hook is synchronous only. Exceptions roll back. Tests cover two-connection lock conflict, stale CAS, throw-before-commit and closing an uncommitted connection; actual machine power loss/crash recovery was not executed.

history() verifies seals, hash chain, contiguous IDs, trusted approvals and current artifact bytes; returns frozen snapshots. bind({operationId,expectedRevision,profileDigest}) rejects unknown, superseded or mismatched targets. Its frozen result contains the exact revision/profile. revalidate(bound) must run at subsequent effect boundaries: it fails if a newer revision exists, never adopts the new configuration. Production gate/config writer serialization is NOT integrated; the existing Task27.15 injected observer demonstrates request-shape compatibility only.

## Approved profile schema

Trusted fixture approval registry is injected out-of-band and defensively copied. Requests select a profileId only, never submit executable/model paths, arbitrary args or environment overrides.

Canonical profile: {version:1,profileId,settings,gpuIdentity,executableSha256,modelSha256}. Settings use the existing explicit launch-spec schema: platform, executable, cwd, modelPath, apiKeyFile, host, port, corsOrigin, device, gpuLayers, contextSize, parallel, verbosity. Deterministic digest = SHA256 of recursively key-sorted canonical JSON.

Paths must be canonical absolute paths inside the fixture root; symbolic/reparse paths are rejected where exposed by Node lstat. Actual executable/model bytes must match trusted SHA256 pins, model must have GGUF magic and suffix. GPU identity is trusted fixture metadata, not a live hardware observation. Host must be 127.0.0.1; CORS exactly matches host/port; key reference must be a regular fixture file; contents are never read by the store. No profile can bypass existing launch-value validation or add unknown CLI fields. Full DLL/build manifest verification remains a later deployment requirement.

## Integrity and trust limits

Each row seal is HMAC-SHA256 over revision, canonical profile text, digest and previous seal, using a separate caller-supplied 32-byte fixture integrity key (not the inference API key). Key is copied in memory and cleared on close; not stored in SQLite. Reopen requires the same trusted key and approval registry. Tests create random synthetic keys and remove all fixture data.

This detects edited rows even if immutable triggers are bypassed. It does not prevent whole-database rollback/deletion, trusted-registry compromise, same-user memory compromise, or a filesystem replacement race. No production ACL/secure key provisioning, rollback anchor, file-handle pinning, or power-loss qualification is claimed. Hashing is fixture-oriented and reads complete small artifacts; this is not a production-size GGUF loader. GGUF magic/hash checks do not establish CUDA compatibility or complete GGUF validity. Historic verification fails closed if approved artifacts are removed or changed; archival policy needs design.

## Tests and readiness

Nine new tests: persistence/reopen; two-connection CAS and active writer conflict; interrupted rollback; stale/unknown/digest mismatch and frozen binding; override rejection; byte-level artifact tampering; unauthorized paths/network weakening; SQL and seal tampering; actual Task27.15 loopback request with stored revision/digest.

Ready for further isolated config/gate integration qualification, NOT controlled real backend replacement. Next require shared writer/activation serialization across all effect boundaries, protected profile authority and revision storage, rollback detection, approved dependency manifests and actual retained-handle replacement qualification. All previous activation gates remain disabled.
