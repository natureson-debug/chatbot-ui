# Stage A current status - 2026-10-27

**Stage A PASS (safe engineering scope); production activation remains BLOCKED.** SQLite missing-file creation is now prevented by SQLite mode=rw; empty/invalid schema is rejected. Explicit first-run initialization is separate and refuses existing files. Target is confirmed RTX 3090 24 GB, driver 595.95. Static CUDA/55-file integrity checks passed; actual non-interactive GPU inference remains Stage B.

See [Stage A policy, evidence, initialization and Stage B plan](STAGE-A.md). Final suite: 283 distinct passing tests; no production SQLite access or service interruption. Supervisor stays inactive with 20/30/35s deadlines and unchanged ownership policy. Rebuild reviewed application pins after these source changes.

## Historical pre-Stage-A report (superseded where noted above)

# Production qualification gate - 2026-10-27

**BLOCKED.** See [PRODUCTION-GATE.md](PRODUCTION-GATE.md) for the current activation matrix, evidence and maintenance/rollback plan. Fresh result: **277 distinct tests passed, zero failures**, 64 syntax checks, two PowerShell parses, source-manifest and diff checks passed. New disposable-DB tests confirm a missing-file recreation gap. Observed hardware is RTX 3090 (595.95), not the task-described RTX 2000 Ada. No competing GPU load was launched. Prior report below is retained as historical baseline.

# RC1 final supervisor qualification ? 2026-10-27

**BLOCKED ? not ready for controlled production activation.**

The inactive versioned candidate in [supervisor/](supervisor/) now fixes the timeout hierarchy and late-response handling, provides disabled unattended-boot XML generation, and passes isolated coordinator/native qualification. The previously staged external supervisor was not changed or activated. Application lifecycle work and all unrelated source changes are preserved.

See [candidate qualification and procedures](supervisor/QUALIFICATION.md) for the authoritative current inventory, timeout hierarchy, startup choice, test evidence, blockers, activation gates and rollback. Historical sections below describe the prior baseline; statements that timeout/channel corrections were not implemented are superseded for the new candidate only.

Final fresh automated result: **272 distinct passed, zero final failures**: 246 repository tests (21 new), 15 original policy tests, 11 candidate native fixture tests. The first sandbox-native attempt failed because it used the wrong account; this is recorded, not hidden. The native re-run used the required normal operator identity. No production application, backend, DB, task, service, credential or network setting was changed.

Remaining production gates: approved batch identity/deployment ACLs, actual non-interactive console/GPU behavior, production SQLite startup review, real backend/application cooperative shutdown and recovery, poisoned-channel recovery and OS-call deadline limitations, orphan reconciliation. Therefore fixture success does not establish unattended production readiness.

## Prior release baseline (preserved for comparison)

# v1.0 RC1 release qualification � 2026-10-26 (Asia/Dubai)

**Status: BLOCKED. Source preparation only; NOT an approved deployable RC.** Mandatory Windows Supervisor startup/recovery qualification is incomplete. No production restart, deployment, task registration or qualification-flag change was performed.

## Completed this task

- Added core/application-lifecycle.js, composing the existing request tracker, graceful HTTP shutdown, shutdown coordinator, database cleanup and orchestrator. Installed by server.js after successful listening; running Node was not restarted. SIGINT/SIGTERM share one operation and registration per server. No process.exit or forced termination.
- Admission drain begins before server.close. Node server.close stops new connections immediately while admitted handlers drain; success requires both HTTP closure and tracker inactivity. Grace period 15s, socket-cleanup confirmation 2s, coordinator deadline 20s. SQLite closure happens once only after qualification; disconnected unfinished handlers keep it open. Incomplete results set nonzero exitCode but never force termination.
- Fixed shutdown-coordinator completion evidence exceptions that could escape Promise callbacks as unhandled rejections.
- Hardened HTTP error boundary: fixed default diagnostic and throwing logger containment.
- Fixed Windows Admin HTML case/alternate-separator/trailing-dot aliases, alternate-stream syntax and static path-boundary checks. Encoded static paths are now rejected, not decoded. Current public assets use simple filenames. Public directory is still trusted deployment content; symlink/reparse protection against a malicious local file writer is not claimed.
- Sanitized upstream inference errors instead of returning raw upstream bodies/exception messages. Server route diagnostics omit exception payloads. Invalid settings now return a generic validation error. Streaming success/persistence contracts unchanged.
- Replaced placeholder npm test command with node --test test/*.test.js (use npm.cmd in execution-policy-restricted PowerShell).
- Added source-only SHA256 preparation manifest and verifier. No API keys, SQLite data, binaries or production external configuration copied.

Files changed by this task:
server.js; package.json; core/application-lifecycle.js (new); core/http-error-boundary.js; core/shutdown-coordinator.js; test/application-lifecycle.test.js (new); test/chat-stream-cancellation.test.js; test/http-error-boundary.test.js; test/shutdown-coordinator.test.js; test/static-file-serving.test.js; release/rc1/* (new).

Pre-existing modifications retained: loopback config, Secure cookies, abort propagation, request tracking and asynchronous static completion, revision API tests, disabled model activation/status changes, Admin theme and CSS updates, lifecycle modules and all previous fixture work. db.js/auth.js not changed. .bak files retained but excluded from preparation manifest. working-tree.txt records the complete review inventory; git diff is not solely this task's work.

## Test evidence

225 repository tests passed via npm.cmd test.
15 staged supervisor policy/readiness tests passed.
10 staged native ownership tests passed, compiled with existing x64 MSVC/SDK and harmless fixtures only.
**250 distinct tests, zero final failures.** No double counting repeated suite runs. The 206+10 historical baseline is superseded by measured discovery, not added to it.
52 JavaScript/CommonJS files syntax-checked; git diff --check passed (existing LF/CRLF notices only). Source manifest generation and verification passed.
New tests use real loopback HTTP and in-memory DatabaseSync; no production db.js initialization. They test drain-before-close, real SQLite use by an active handler, disconnect/stall, duplicate signals, single close, closure failure, inactivity-evidence exception, diagnostic failure, error redaction and Windows static aliases.
An initial new evidence-exception test failed, demonstrating an unhandled rejection; both completion callback paths were fixed, and final suites pass.
Native artifacts: C:\Users\Admin\AppData\Local\Temp\chatbot-owned-test-eTXefM. Tests cover retained identity, exclusive service leases, foreign listeners, incomplete shutdown, disconnect, child/broker/supervisor crash and stale leases. Read-only post-test inspection found no remaining corresponding fixture processes. Native crash tests intentionally retain test stale-lease evidence. No real backend model load/inference or production application shutdown tested.

## Release security assessment

- Node and llama addresses are configured 127.0.0.1:3000/8080; no direct LAN binding enabled. Current TLS proxy/cert deployment and actual LAN reachability were not inspected or altered. They require acceptance evidence; do not infer HTTPS from Secure cookies.
- API routes retain auth/admin/ownership checks and original-session revalidation for message persistence. Passwords use scrypt; sessions store token hashes. Cookies retain HttpOnly, Secure, SameSite=Strict. Login abuse/rate controls and hostile-client resource limits need deployment threat assessment before internet exposure.
- Inference retains bearer API-key authentication. No production secret read during this task; module import avoided in isolated tests.
- DB initialization still performs CREATE IF NOT EXISTS and conditional ALTER migrations, including revisions. Production schema was not inspected; no claim of write-free startup. Operator-approved schema/backup review is required before restart. Active writes must not be interrupted by copying only the main SQLite file; use an approved consistent backup including WAL state or SQLite backup facility.
- Staged supervisor runs least privilege and verifies native identity, fixed profile and dependency hashes. User-owned staging is not protection from same-account compromise. Production executable/dependency trust, credentials and peer management-channel protection remain unqualified.

## Mandatory supervisor blockers

1. startup-task.xml is DISABLED, InteractiveToken and a user LogonTrigger, NOT unattended boot startup. No task was registered. Decide whether v1.0 accepts post-login availability; otherwise qualify a non-interactive least-privilege identity. Do not silently replace it with SYSTEM.
2. qualification.json: activationApproved/modelLoadPassed/generationPassed/gracefulBackendStopPassed/gracefulNodeStopPassed/databaseStartupApproved all false. Actual application/backend graceful stop, GPU readiness, boot/login and crash recovery remain unverified.
3. Broker STOP currently allows ~10s; application shutdown allows 20s. Must align tested deadlines with a confirmation margin without forcing a child that still holds SQLite. This task did not recompile/replace staged production brokers.
4. staged broker-client.cjs still permits late timed-out replies in its queue. Test-local poisoning is not deployed; production channel needs qualification of timeout/incomplete ownership handling.
5. Source changes invalidate compiled application dependency hashes. Rebuild/review exact profile and dependency manifests; never bypass checkGate or merely refresh hashes without provenance review.
6. Existing external services must remain external. No adoption or PID-based stop. Clean initial ownership requires an explicitly approved transition plan after fresh identity/task evidence.
7. Live-unhealthy owned backend currently reports degraded status without restart; exited-process recovery has bounded backoff/budget, but actual production recovery and orphan reconciliation are not qualified. Stale leases deliberately block.
8. Model activation is intentionally 503-blocked. TEST management/revision transaction prototypes do not provide production authority. If RC1 requires hot model switching, that is an additional unresolved release requirement.

## Reproduce preparation (no production startup)

From C:\AI\chatbot-ui:

    npm.cmd test
    node --test "C:\Users\Admin\AppData\Local\Chatbot\startup\v1\test\policy.test.cjs"
    node release/rc1/manifest.cjs --verify
    git diff --check

Native tests require an authorized normal operator session and create harmless processes:

    node --test "C:\Users\Admin\AppData\Local\Chatbot\startup\v1\test\native.test.cjs"

manifest.cjs without --verify regenerates the source inventory; use only during reviewed preparation. The manifest is integrity evidence, not a signature or authenticity proof. This package is deliberately not an installer or auto-activation script.

## Proposed activation sequence � STOPPED, separate explicit approval required

These are ordered gates, not an executable approval bypass. There is no safe one-command activation while the above blockers remain.

1. Resolve boot-versus-logon execution identity and deadline/channel defects; qualify with isolated fixture applications and synthetic SQLite first. Review exact binaries/source hashes and rollback package. Preserve all legacy SYSTEM tasks disabled.
2. Obtain explicit maintenance-window approval, console recovery access and exclusive lifecycle coordination. Fresh administrative read-only evidence must establish all three legacy tasks disabled/no instances; verify current process identities and listeners independently.
3. Approve consistent production DB backup and read-only schema review. Inspect pending migrations before any server.js initialization. Prepare previous reviewed application/supervisor package without reverting unrelated changes in the working tree.
4. Approve retained-handle shutdown of identified current services through their existing owners. If external identity or stop authority is unclear, stop; never adopt/kill by PID. Confirm port release and no competing launcher.
5. Rebuild approved supervisor brokers against the exact accepted application/dependencies; qualify actual model load, generation, Node DB startup and graceful stop under controlled approval. Populate qualification evidence from tests, not guessed booleans. Keep scheduled startup disabled during manual qualification.
6. After all gates pass and separate activation approval, run the exact approved operator command:
   & 'C:\Program Files\nodejs\node.exe' 'C:\Users\Admin\AppData\Local\Chatbot\startup\v1\supervisor.cjs' --run
   Only after manual supervised acceptance register/enable the reviewed startup definition appropriate to the approved boot/logon decision. Current XML must NOT be enabled as proof of unattended boot support.
7. Independently approve logout/reboot testing. Verify startup, identity, GPU, authenticated health/inference, UI auth/persistence, graceful shutdown and bounded crash recovery. No release claim before these pass.

## Exact rollback sequence (requires explicit operational approval)

1. Halt further activation/recovery; preserve logs, ownership evidence and DB. Do not automatically re-enable legacy SYSTEM tasks.
2. If the new supervisor actually owns the affected processes, request cooperative stop with the approved --stop interface:
   & 'C:\Program Files\nodejs\node.exe' 'C:\Users\Admin\AppData\Local\Chatbot\startup\v1\supervisor.cjs' --stop
   Verify retained-handle exit, streams and listener release. If incomplete/unverifiable, stop rollback and escalate review; do not delete leases or PID-kill.
3. Remove only the newly registered task after verifying its exact identity/action, using reviewed task.ps1 -Mode Remove. This does not stop processes. Do not operate on legacy tasks.
4. Restore only the separately captured approved application/supervisor artifacts, with reviewed hashes. Never git reset --hard or overwrite the live DB. If migrations occurred, schema rollback requires its own consistency/data-loss review; no automatic DB downgrade.
5. Start the previous reviewed non-elevated owned deployment only after port/ownership/config checks and explicit approval. If that cannot be made safe, remain offline and report rather than restoring unsafe SYSTEM execution.

## Post-activation acceptance checklist

- Correct execution identity, non-elevated token, one owning supervisor and one backend/application.
- Expected loopback listeners, no exposed inference listener; TLS/LAN UI path and Secure cookies work from intended clients.
- Authenticated health/models and one authorized short inference; expected model/GPU offloading.
- Synthetic approved UI chat: SSE completion, cancellation, persistence, clear/revision conflict handling.
- Cooperative app stop logs completed=true and databaseClosed=true; no double-close, pending handler DB access or crash events.
- Backend refusal/start failure is bounded and Node admission follows dependency policy; no restart loop.
- Actual logon/boot behavior matches the approved requirement; real controlled crash recovery is verified.
- Rollback tested and legacy tasks remain disabled.

Approval requested: review these source changes and the blocked release plan. Controlled production activation requires a fresh explicit approval AFTER the mandatory blockers have been resolved; current evidence does not justify activating now.
