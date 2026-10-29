# Stage A - SQLite startup safety and RTX 3090 inspection

2026-10-27. **Stage A PASS for safe engineering and non-disruptive qualification. Production activation remains BLOCKED.** GPU inference and batch-session lifecycle acceptance are explicitly deferred to Stage B; they are not passing tests.

## Database policy

The only application database location remains `<project>/data/chatbot.db`, derived from the directory containing db.js, independent of shell cwd and CHATBOT_HOME. No environment override or second path configuration was added. On this workstation that is C:\AI\chatbot-ui\data\chatbot.db.

Normal startup calls openExistingDatabase(): an encoded file URI with mode=rw is passed as a string to Node DatabaseSync. SQLite enforces read/write **without create**, eliminating the missing-file existence-check race. Verified on Node 24.19.0 with disposable paths, including spaces/#/&. This Node build/runtime behavior is part of release qualification; do not assume every alternative SQLite build handles URI names identically. See [SQLite open semantics](https://sqlite.org/c3ref/open.html) and [URI mode](https://sqlite.org/uri.html).

Before migration, require the existing legacy Chatbot chats/messages tables and base columns, then PRAGMA quick_check=ok. Empty files, empty schemas, unrelated SQLite files and malformed databases are rejected. An intentionally initialized database may legitimately have zero user/message rows. The original legacy schema remains accepted; missing later tables/columns are migrated by the same shared schema implementation. This recognizes the application schema, not cryptographic database provenance or protection from malicious same-account replacement.

Existing CREATE/ALTER definitions moved without schema changes to core/database-schema.js. All schema initialization/migrations now run in one BEGIN IMMEDIATE transaction, with rollback on failure. Foreign keys remain enabled. db.js retains the existing exported query/transaction API. Errors close only the connection opened by that failed startup and propagate DB_STARTUP_FAILED, DB_SCHEMA_INVALID or DB_INVALID with recovery guidance and original cause; no listening server is started. No retry, deletion, repair, fallback database or automatic directory creation occurs.

### Explicit first installation only

After deliberately creating the intended data directory and reviewing its permissions, with no existing database:

    & 'C:\Program Files\nodejs\node.exe' 'C:\AI\chatbot-ui\scripts\initialize-database.cjs' --create-new-database

This procedure was NOT executed against the project data directory. It shares databasePath() and initializeSchema(), reserves the absent filename using exclusive wx, and refuses any existing target (including empty/corrupt files). It creates schema only, not accounts or credentials. Failed initialization leaves the reservation for operator review rather than deleting or retrying. Missing data directory is an actionable failure. The CLI accepts no alternate path and no environment override. Tests copy this CLI and its two modules into a disposable root to verify its real behavior safely.

This command is **never a recovery procedure**. For a missing/corrupt production database, stop startup and restore/review a consistent approved backup with WAL awareness. Do not copy only the main active WAL database, use immutable=1 on an active database, or initialize an empty replacement. Review migrations/backup before the next approved restart. The live schema has not been opened or migrated in Stage A.

## GPU and binary evidence

Read-only inspection at 12:10 Asia/Dubai: GeForce RTX 3090, UUID GPU-4cc4e779-9cd5-695d-7afb-11c71c58f82e, 24576 MiB, driver 595.95; approximately 6538 MiB in use. RTX 2000 Ada qualification is historical only and is not evidence for this target. Current candidate UUID already matches; no profile, device setting or driver changed.

55 staged files matched the recorded SHA-256 manifest, zero mismatches. This is local integrity evidence, not independent authenticity or proof of runtime compatibility. The staged b11609 executable lacks a FileVersion resource; build identity here derives from the reviewed package/manifest, not a new executable invocation.

PE import inspection (dumpbin, no backend execution): llama-server.exe imports llama-server-impl.dll; implementation imports llama-common, mtmd, llama, ggml-base/ggml plus Windows/MSVC libraries. ggml-cuda.dll imports cudart64_12.dll, cublas64_12.dll and driver nvcuda.dll. App-local cublasLt64_12.dll also exists. Raw file versions: cudart 6,14,11,12040; cuBLAS/cuBLASLt 6,14,11,1245. These resource values are reported literally, not treated as toolkit version numbers. Manifest/package identifies CUDA 12.4; do not assume every app-local DLL is loaded.

NVIDIA documents newer-driver backward compatibility for CUDA 12.x: [compatibility guidance](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html). Driver 595.95 is consistent with that requirement; this does not prove usable kernels, model offload or inference. No CUDA execution test was performed. Production b11609 PID 22088 still owns 127.0.0.1:8080; Node PID 9280 owns 127.0.0.1:3000. Active shared GPU workload means spare VRAM alone cannot establish a non-disruptive second test. No competing instance was launched.

## Validation and changes

257 repository tests + 15 original supervisor policy tests + 11 native harmless fixture tests = **283 distinct passes**, zero final failures. Startup suite now covers 11 scenarios, including actual initializer CLI, access denial, locks, repeated data/revision preservation, legacy migration, empty/malformed rejection and URI escaping. Existing API/revision tests use the shared schema through their in-memory injection seam; they never resolve a production DB. Existing migration rollback, authentication and HTTP response assertions remain intact.

Changed application files: db.js; new core/database-startup.js, core/database-schema.js and scripts/initialize-database.cjs. Updated tests: test/rc1-db-startup.test.js, test/chat-revisions.test.js, test/chat-revision-api.test.js (injection wiring only; prior unrelated modifications preserved). Release changes: this report, READINESS.md, PRODUCTION-GATE.md, supervisor/QUALIFICATION.md, manifest.cjs (include initializer scripts), source-manifest.json, test-results.txt and working-tree.txt. Supervisor ownership/deadline implementation and activation flags are unchanged.

## Stage B requirements - separate approval required

1. Review this source, compile/pin the revised application dependency manifest and preserve the previous artifact version. Do not activate old brokers with stale pins.
2. Obtain authorized read-only production schema/backup review and a consistent recoverable backup; confirm no unexpected migration/data repair is needed. Do not use first-run initialization on production.
3. Approve intended batch account/SID, protected deployment/state directories, key-read and log/cache permissions, batch-logon rights and credential handling. Current development ACLs are not a protected deployment. Fresh administrative evidence must confirm all legacy tasks disabled/zero instances.
4. Approve maintenance ownership and console recovery; stop existing workloads only through verified current owners. New supervisor may not adopt external processes. Do not use historical PIDs as stop authority.
5. In the intended non-interactive account, qualify harmless private-console shutdown first. Then run one reviewed b11609 load on a separate loopback test port (e.g. 18080), RTX 3090 UUID mapping verified to CUDA0, Qwen3-8B-Q5_K_M.gguf, 37 layers, ctx 32768, parallel 1, verbosity 4, existing key-file reference, isolated state/logs. Require actual 37/37 layers, CUDA model/KV allocation and authenticated ready/model identity. Model loading alone is insufficient: one separately approved bounded authenticated generation must pass.
6. Qualify actual retained-handle graceful shutdown, exit/stream/listener release, startup/shutdown deadlines, duplicate rejection, controlled crash/recovery and bounded retry. GPU-unavailable cases must not alter production driver/settings. Uncertain ownership remains blocked for operator intervention.
7. Only after evidence review, approve enabling the new boot entry and controlled reboot/no-login acceptance. Verify Node/SQLite shutdown and real GPU inference under intended identity before declaring production release complete.

Rollback: stop only owned candidate processes through verified authority; if uncertain, preserve records and stop escalation. Keep legacy SYSTEM tasks disabled. Restore only approved artifacts after listener/ownership release. Database restoration/downgrade is a separate approved operation, never automatic. No production changes, DB opens, service restarts, tasks, ACLs, credentials, commits or pushes occurred in Stage A.

Final static checks: 67 JavaScript/CommonJS syntax checks, two PowerShell parses and git diff --check passed. Source manifest was regenerated to include the new shared schema/startup modules and explicit initializer, then verified. Native fixture root: C:\Users\Admin\AppData\Local\Temp\chatbot-owned-test-V22Bo6. No fixture processes remain; diagnostic artifacts are retained only in Temp. Production listeners were reverified unchanged at cleanup (9280/3000, 22088/8080).

