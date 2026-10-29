# Stage A current status - 2026-10-27

**Stage A PASS (safe engineering scope); production activation remains BLOCKED.** SQLite missing-file creation is now prevented by SQLite mode=rw; empty/invalid schema is rejected. Explicit first-run initialization is separate and refuses existing files. Target is confirmed RTX 3090 24 GB, driver 595.95. Static CUDA/55-file integrity checks passed; actual non-interactive GPU inference remains Stage B.

See [Stage A policy, evidence, initialization and Stage B plan](STAGE-A.md). Final suite: 283 distinct passing tests; no production SQLite access or service interruption. Supervisor stays inactive with 20/30/35s deadlines and unchanged ownership policy. Rebuild reviewed application pins after these source changes.

## Historical pre-Stage-A report (superseded where noted above)

﻿# RC1 Production Qualification Gate - 2026-10-27

**Decision: BLOCKED. Do not activate.** This report supersedes readiness claims in older baseline sections, not their historical evidence.

## Current observed environment

Read-only operator inspection at 11:55-11:58 Asia/Dubai: DESKTOP-6513LCM\Admin, SID S-1-5-21-1162025873-2456272895-3354061701-1001, non-elevated token. NVIDIA reports RTX 3090, UUID GPU-4cc4e779-9cd5-695d-7afb-11c71c58f82e, driver 595.95, 24576 MiB total and approximately 6510 MiB used. This differs from the task's RTX 2000 Ada description; it matches the candidate's GPU UUID. No hardware/profile change was made.

Node PID 9280 owns 127.0.0.1:3000; b11609 PID 22088 owns 127.0.0.1:8080. Executable paths match Program Files Node and the staged b11609 directory respectively. NVIDIA compute inventory includes PID 22088; per-process VRAM is N/A. These are identity/listener observations, not new inference or offload qualification. Production processes were not signalled or adopted.

Visible Admin Restart task is Disabled. Backend and Watchdog queries are unavailable under this token; historical evidence is not fresh verification. No tasks were invoked or changed.

Candidate activation flags remain false; candidate state and compiled-build directories are absent. Only source preparation is present. No dedicated ChatbotBackend local account was found. The candidate still specifies Admin; a generated batch-logon task does not establish batch-logon rights, encrypted-file access, credentials, session behavior or boot persistence.

ACL metadata: API-key file grants only Admin and SYSTEM FullControl (contents not read). Data directory/database and repository candidate directory grant Authenticated Users Modify among other entries; the candidate directory owner is CodexSandboxOffline. These are explicit ACL observations, not a complete effective-access calculation. They are unsuitable evidence of protected deployment. A future dedicated identity does not presently have a demonstrated key access grant. No permissions were changed and no write probe was made.

## Activation matrix

| Requirement | Result | Evidence / remaining gate |
|---|---|---|
| Prior source baseline integrity | PASS | Every entry in prior manifest matched before regeneration; only new test/report files added |
| Full regression and native harmless tests | PASS | 277 distinct final tests: 251 repository + 15 original policy + 11 candidate native |
| 20/30/35-second deadline hierarchy | PASS | Source plus repeated native 21-second graceful drain; not proof of actual llama.cpp shutdown |
| Disabled boot definition construction | PASS | Password logon, LeastPrivilege, BootTrigger, IgnoreNew; XML generation only |
| Unattended execution identity/GPU | NOT VERIFIED | No qualified batch identity; current interactive token proves no unattended capability |
| Trusted code/state deployment ACLs | FAIL | Candidate remains broadly writable development staging; no protected deployment provisioned |
| Actual boot/reboot/no-session availability | REQUIRES PRODUCTION ACTIVATION | Must test intended account/session/driver with explicit maintenance approval |
| DB path and directory existence | PASS | Source resolves __dirname/data/chatbot.db; metadata confirms directory and file exist |
| Malformed/open/lock failure propagation | PASS | Actual db.js evaluated with disposable path; malformed bytes preserved, lock/open failure abort |
| Missing DB replacement prevention | FAIL | Disposable test proves absent chatbot.db is created when data directory exists |
| Migration preservation/rollback | PASS | Existing isolated revision tests; only revision migration is atomic, earlier ALTERs are separate |
| Live schema, pending migrations, WAL recovery | NOT VERIFIED | Production DB not opened or copied; no inference of schema from a running service |
| Actual b11609 startup/stop/crash recovery | NOT VERIFIED | No additional GPU backend launched; active production GPU workload makes non-interference unproven |
| Stale ownership, timeout, duplicate prevention | PASS | Protocol poison, retained handles, CREATE_NEW lease, no PID reopen or force API; isolated tests |
| Automatic recovery from uncertain ownership | NOT VERIFIED | Intentionally blocked; requires operator intervention, never timeout-to-exit assumption |
| Legacy task inactivity | NOT VERIFIED | Only Admin Restart visible disabled; fresh elevated evidence needed for other two |
| Application/backend production acceptance | REQUIRES PRODUCTION ACTIVATION | Actual health, inference, graceful stop/recovery and reboot still mandatory |

A passing test of the observed missing-DB creation behavior does NOT make the replacement-prevention requirement pass.

## SQLite qualification detail

No production DB handle was opened. Tests run actual db.js in a VM with __dirname bound to a new temporary directory and a tracked DatabaseSync wrapper. Production auth is not imported; no credentials are needed. All test handles close and temporary files are removed.

New tests: missing data directory aborts; absent DB is created; malformed file aborts unchanged; exclusive lock aborts and initialization works after owner rollback; injected access-denied constructor failure propagates without alternate path. Lock test uses two real disposable SQLite connections, not timing sleeps. Startup has no configured application busy retry here. A failed startup is not database repair.

Source has CREATE IF NOT EXISTS and conditional theme/user_id/display_content ALTERs before the revision transaction. Thus startup as a whole is not one migration transaction. Revision changes roll back on error; earlier successful schema steps may remain. No persistent migration-version ledger beyond inspected columns was found. Database opening occurs during require before server listening; errors propagate, so there is no falsely healthy HTTP server, but diagnostics are native exceptions rather than a dedicated startup outcome code. No fs.mkdir or deletion/replacement recovery is performed by db.js.

A preflight Test-Path alone cannot provide race-free prevention of accidental database recreation. Before deployment, review an open-existing-only database policy appropriate to Node's SQLite API and the intended deployment, or another enforceable control. Do not fix this by hashing/pinning an actively changing SQLite file. No production source change was made in this gate task. Interrupted-write/WAL recovery and live schema remain separate controlled acceptance requirements; do not use immutable=1 or copy only the main active WAL database.

## Ownership qualification detail

Original Windows process handle remains termination/identity authority. No OpenProcess-by-PID or arbitrary termination API exists. Native lease is exclusive CREATE_NEW and retained; stale lease is not deleted automatically. External healthy services are monitored, never owned. Incomplete stop, missing stream closure or unreleased listener cannot permit replacement. Alive-but-unhealthy is reported, not killed.

Client timeout revokes the channel permanently. Lost START acknowledgement may leave an owned child alive; timeout is not exit evidence. The supervisor retains blocked state/lease, rejects further actions and requires intervention. Same-handle creation-time checks prevent PID substitution. Actual OS PID reuse was not forced; guarantee is established by retained-handle design/static review and identity tests, not a fabricated reuse event.

Native synchronous process/file operations can outlive the client deadline. There is no safe automatic recovery from a poisoned channel or stale orphan lease. This is intentional fail-closed behavior, not crash-safe recoverability. Manual intervention must preserve the existing handle authority or use a separately approved, freshly verified administrative procedure; never delete leases to get a green startup.

## Exact controlled qualification sequence - NOT EXECUTED

Non-disruptive preparation:
1. Resolve RTX 3090 versus RTX 2000 Ada target; approve the exact GPU UUID/driver/profile. Preserve current driver. Review source-manifest, candidate code and versioned rollback artifacts. Re-run node release/rc1/manifest.cjs --verify and git diff --check.
2. Select exact batch account SID and protected deployment/state paths. Verify RX for code/models, key read, log/cache/state write, database permissions for the application identity, batch-logon right, least-privilege token and credential rotation. Resolve missing-DB guard and migration diagnostics before startup. Do not reuse a sandbox-owned development directory as trusted deployment.
3. Obtain fresh elevated read-only evidence for all three legacy tasks: Disabled, zero instances, exact actions. Capture current service creation time, executable, owner and listener PID. Verify no unknown launcher/recovery. Never treat E_ACCESSDENIED as inactivity.
4. Approve a consistent SQLite backup/schema review procedure with WAL awareness. Record backup integrity, restoration credentials/access and prior artifact version. No live main-file-only copy. Confirm local-console recovery access and maintenance ownership.

Maintenance window (requires separate approval):
5. Arrange shutdown of existing production processes through their current verified owners. New supervisor cannot adopt PID 9280/22088. Revalidate identities immediately; historical PIDs are not stop authority. Abort if ownership is ambiguous. Confirm listeners and GPU workload released.
6. Provision the approved account/deployment/ACLs under separately approved administrative change control. Generate XML with bootTask({sid,node,supervisor,cwd,delaySeconds:30}) using the approved absolute paths; register DISABLED with credential handling outside command-line/logs. Inspect exact principal, action and task DACL. No executable registration command can be finalized until those deployment values are approved. No legacy task is enabled.
7. First run a harmless broker fixture in the intended non-interactive batch context: verify identity, private-console signal delivery, retained-handle identity, output closure and listener release. Then authorize one real model-load qualification with reviewed b11609 path, Qwen3-8B-Q5_K_M.gguf, selected UUID/CUDA mapping, 37 layers, ctx 32768, parallel 1, verbosity 4, loopback and existing key-file reference. Use dedicated test port and isolated state; never print the secret. Model loading alone qualifies memory/offload/readiness, not inference.
8. Separately authorized short authenticated generation confirms inference. Verify /health, /v1/models, actual loaded model identity, 37/37 offload and CUDA buffers, timeout/cancellation and logs without secrets. Exercise actual graceful backend and application shutdown, retaining handles; verify HTTP drain/DB close, streams and ports. Test unexpected exit and bounded recovery only on isolated owned processes with synthetic DB, then approved production-equivalent configuration. No arbitrary PID termination. Test startup/GPU-unavailable and shutdown-timeout conditions without changing the live driver.
9. Populate qualification evidence only after tests pass, rebuild exact reviewed broker manifests and run the approved deployed supervisor --run manually under intended identity. Validate one owner and startup ordering. Then separately approve enabling ONLY the new boot task and a reboot. Verify before interactive login: identity, GPU, health, one synthetic authorized inference, application auth/persistence, logs and bounded recovery. Do not declare release complete before this succeeds.
10. Record exact task name, deployed command, SID, source/binary hashes, process identities, expected listeners and evidence locations in final operational runbook. Current candidate is not an install-ready package; inventing those values would conceal unresolved deployment decisions.

Rollback triggers: unexpected identity/listener, hash/ACL mismatch, failed health/model/offload, migration errors, duplicate process, shutdown timeout, uncertain ownership, restart-budget exhaustion, unexpected exposure or failed unattended boot. Stop further recovery. For owned processes only, use exact deployed supervisor --stop and verify exit/streams/listeners. If incomplete, preserve ownership/evidence and stop; no PID kill or lease deletion. Disable only the newly approved startup entry, restore reviewed code/binaries after ownership release, and keep legacy SYSTEM tasks disabled. DB restore/downgrade requires its own consistent-backup/data-loss decision. Success means known safe prior service or explicitly offline state, no duplicates, preserved data and documented task state; never automatic unsafe SYSTEM rollback.

## Changes and approval boundary

Only new isolated test/rc1-db-startup.test.js and release reports/inventories were changed in this task. No production source, process, database, task/service, ACL, credential or network setting changed. No real inference or production health request was needed. No commit/push.

Required next decision: approve the target GPU and intended batch identity/deployment plan, and authorize a scoped maintenance-window qualification after the missing-DB protection/deployment security gaps are resolved. This report does not recommend enabling production startup now.

Final validation: 277 distinct passed, zero failures/skips in executed suites; 64 syntax checks, two PowerShell parses, diff check and regenerated source manifest passed. Initial full manifest comparison detected the newly added test as expected; every pre-existing entry separately matched. No remaining fixture processes were found. Production listeners still belong to Node 9280 and llama.cpp 22088. Native compiled fixture artifacts remain only in temporary diagnostic storage. No actual unattended/GPU lifecycle test is counted as passed.
