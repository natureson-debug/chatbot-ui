# Stage A current status - 2026-10-27

**Stage A PASS (safe engineering scope); production activation remains BLOCKED.** SQLite missing-file creation is now prevented by SQLite mode=rw; empty/invalid schema is rejected. Explicit first-run initialization is separate and refuses existing files. Target is confirmed RTX 3090 24 GB, driver 595.95. Static CUDA/55-file integrity checks passed; actual non-interactive GPU inference remains Stage B.

See [Stage A policy, evidence, initialization and Stage B plan](../STAGE-A.md). Final suite: 283 distinct passing tests; no production SQLite access or service interruption. Supervisor stays inactive with 20/30/35s deadlines and unchanged ownership policy. Rebuild reviewed application pins after these source changes.

## Historical pre-Stage-A report (superseded where noted above)

# Production gate follow-up - 2026-10-27

**BLOCKED.** Current findings and activation matrix: [../PRODUCTION-GATE.md](../PRODUCTION-GATE.md). Fresh qualification: 251 repository + 15 original policy + 11 native = **277 passed**, no failures. Syntax: 64 JS/CommonJS, 2 PowerShell. Native root: C:\Users\Admin\AppData\Local\Temp\chatbot-owned-test-dVPl5S; fixtures exited. No runtime implementation changed this follow-up. Unattended identity/GPU, live DB schema and missing-file protection, actual backend recovery and deployment trust remain unresolved. Historical candidate qualification follows.

﻿# Supervisor candidate qualification — 2026-10-27

Status: BLOCKED for activation. This directory is a new, inactive source candidate. The external startup/v1 supervisor and its compiled brokers were not replaced.

## Implementation and evidence

- broker-client.cjs: one outstanding response, strict sequence, no queued late replies; timeout/protocol failure permanently revokes channel. No automatic disconnect or process termination. QUIT waits for stream close, not just exit.
- timeouts.cjs: application remains 20s total (15s HTTP drain, bounded cleanup); native cooperative stop 30s; supervisor STOP response 35s; ordinary reply 15s; hello 10s; QUIT 5s; startup 300s. Readiness observations are capped to remaining budget. A real harmless 21s drain completed gracefully with streams and listener released.
- supervisor.cjs: same existing authority and retained-handle broker; injected effects for tests; cancellable 200ms backoff; signal listeners removed on completion; compiled operator SID checked. Existing external services never enter owned map. Incomplete/poisoned ownership remains blocked; it is not silently abandoned.
- build.cjs/src/broker.cpp: compile reviewed SID from profile; application pin set now includes server, auth, DB, package and core JavaScript modules. Source hashes do not authenticate origin or secure writable parent directories.
- observe.ps1: operator SID read from reviewed profile, not an independent hard-coded SID.
- boot-task.cjs: pure XML generator. Disabled BootTrigger, configurable 0..600s delay (30s default), Password batch logon, LeastPrivilege, IgnoreNew, no scheduler restart loop, no hard termination, no credentials in XML. Does not register anything.

## Startup architecture

Choose Task Scheduler for the next controlled qualification: boot trigger under an explicitly approved standard local batch account. SYSTEM is rejected. Register using Windows credential handling, never plaintext password arguments. Required rights include batch logon, RX approved code/model, read key, and write only reviewed logs/state/cache. Existing Admin-named operator profile is not proof of a dedicated account or batch-session readiness. No account, rights or ACL provisioning was performed.

A Windows Service would require an SCM-aware host implementing StartServiceCtrlDispatcher and service controls; the current Node console program is not such a service. Adding an unqualified wrapper now adds authority and shutdown behavior. Task Scheduler is the smaller next step. S4U is not selected: its documented network/encrypted-file restrictions add qualification uncertainty. Password rotation and account recovery need an operational owner.

References: https://learn.microsoft.com/en-us/windows/win32/services/service-entry-point and https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type .

## Remaining blockers

1. No non-interactive batch account/session qualification: private console CTRL_C behavior, CUDA/model initialization, key access and logout/boot behavior remain untested. No production startup definition was registered.
2. All qualification flags remain false. No actual Node DB opening/migration, backend launch, production stop, crash recovery or inference was exercised.
3. Native synchronous Windows calls (process creation, file/hash reads) cannot be claimed to have hard wall-clock bounds. Client response expiry blocks further actions but does not cancel an already issued native operation. Broker may finish a START late while retaining its lease; supervisor stays blocked with unknown outcome. This is a safety block, not successful recovery. Read-only observer timeout does not prove PowerShell exit.
4. A poisoned broker cannot receive a new cooperative stop. No PID adoption, force fallback or automatic lease deletion is allowed. Out-of-band retained-owner recovery requires separate design/qualification.
5. User-owned staging is not a security boundary against same-account compromise. Protected code, dependency/DLL search paths, state directory provisioning, key ACLs and task definition security need reviewed deployment. Candidate state directory is deliberately not provisioned by this task.
6. Leases fail closed after a crash. Unattended orphan reconciliation is not implemented. Native fixture crash results do not establish real database/backend safety.
7. Model activation remains blocked; TEST management channel is not production integrated.

## Tests and cleanup

Fresh repository suite: 246 passed, zero failures (includes 21 new candidate tests). External original policy suite: 15 passed. Candidate x64 native suite: 10 passed plus separate 21-second-drain test: 1 passed. Total distinct final passing tests: 272. Synthetic coordinator tests execute actual main() with injected filesystem, clock, observation, health and broker effects, not production providers.

Initial native sandbox run failed 9 tests because the sandbox identity was CodexSandboxOffline, not the profile SID; it passed only the static check. Its isolated runner was stopped after verifying its test command/creation time. No production process was stopped. Re-run under normal non-elevated Admin operator passed; privilege escalation was not used inside the broker. Compiler: MSVC 19.44.35229 x64; SDK 10.0.22621.0. Generated files reside only in temporary chatbot-owned-test directories.

Native artifact roots: chatbot-owned-test-lTBxzT (failed sandbox), chatbot-owned-test-QeJMlb (10 pass), chatbot-owned-test-KnDyqR (long drain pass), under the operator LocalAppData Temp directory. Read-only process inspection found no remaining test Node/broker processes. Intentional stale leases and compiled diagnostic artifacts remain in those isolated directories; they are not active production records.

## Reproduce without production effects

    npm.cmd test
    node --test release/rc1/supervisor/test/native.test.cjs
    node release/rc1/manifest.cjs --verify
    git diff --check

Native tests must run as the reviewed non-elevated operator SID. They compile and launch only harmless fixtures on temporary loopback ports. Do not run supervisor.cjs --run or build.cjs main against production until separately approved.

## Activation and rollback gates

There is deliberately no activation-ready one-line command. First approve dedicated identity, protected deployment location and state provisioning; qualify boot-session console/GPU behavior with harmless fixtures, then separately authorize production DB schema/consistent-backup review and controlled model/application tests. Build the exact reviewed manifests for that identity. Never merely flip qualification booleans. Keep legacy SYSTEM tasks disabled.

After all evidence and approval, generate disabled XML using bootTask({sid,node,supervisor,cwd,delaySeconds}) with exact reviewed absolute paths. Register disabled with approved batch credentials through an administrative operator, inspect its principal/action/ACL, then separately authorize enabling and boot testing. Existing external Node/backend must not be adopted or stopped by the new supervisor. Their transition requires existing-owner authority.

Rollback during this preparation is simply to leave this candidate inactive. After a later authorized activation: request --stop through the exact deployed supervisor; verify owned child exit, streams and listeners; disable/remove only its reviewed new startup entry; restore the separately approved artifact version. If ownership/stop is uncertain, stop rollback and preserve leases/evidence. Never re-enable insecure SYSTEM tasks or restore a database automatically. Database schema/data rollback needs its own approved consistency plan.

Static validation: 63 JavaScript/CommonJS syntax checks and two PowerShell parse checks passed; source manifest verification and git diff --check passed. Full working-tree inventory is ../working-tree.txt; candidate file inventory is ../supervisor-files.txt. Existing uncommitted application changes are not attributed to this candidate.

SQLite/source review: package.json declares no third-party dependencies and no lockfile is present. Node 24 node:sqlite DatabaseSync is required; validation ran on Node 24.19.0. db.js initialization opens the configured database, executes CREATE IF NOT EXISTS and conditional ALTER migrations (theme, user_id, display_content and durable revisions). Revision migration uses a synchronous write transaction with rollback and safe-integer validation. Opening/migration errors must abort startup; restarting is not guaranteed write-free. Isolated database regression tests passed; production schema and WAL state were not accessed. A consistent approved backup and migration review are still required. Existing backend manifest checks local integrity, not upstream authenticity or target GPU compatibility.
