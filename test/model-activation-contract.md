# Task 27.14: model activation qualification contract

Status: DESIGN + TEST-ONLY predicates. No production adapter, endpoint, process management, or supervisor changes. Not ready for a controlled production activation trial.

## Inspected implementation

External staging root: C:\Users\Admin\AppData\Local\Chatbot\startup\v1.
- supervisor.cjs exposes --run, --status and --stop only. checkGate requires qualification flags; all flags remain false. Its owned map contains broker clients; external map is observation only. A status.json record is not ownership proof. It holds a supervisor.lease created with wx; stale leases block rather than being reclaimed.
- broker-client.cjs starts a bridge with private pipes, validates nonce/version/non-elevated greeting and sequences requests. START/STATUS/STOP/QUIT only. Timeout uses Promise.race and does not remove the waiting reply consumer or permanently poison the channel: late responses and uncertain completed commands need explicit fail-closed handling before activation integration.
- src/broker.cpp retains the CreateProcessW handle; identity uses GetProcessTimes, GetProcessId and QueryFullProcessImageNameW. CREATE_NEW service lease remains held. STOP sends CTRL_C in the private console; incomplete shutdown retains the handle and lease. Replacement requires exit, output closure and listener release. No arbitrary PID termination/adoption.
- Compiled TARGET_PATH/CWD/arguments and dependency pins are fixed. No runtime model-switch command exists. A new profile must not be accepted as arbitrary client-provided command text.
- readiness.cjs verifies owned listener and health plus hard-coded 37/37 CUDA buffer evidence. It does not establish actual model identity, and is not generic across approved GGUF profiles.
- Existing core/lifecycle-policy.js is TEST-only, with operation serialization, retained-handle tokens, deadlines, ownership-loss blocking and bounded recovery. Keep this as the transition-policy basis; do not create another production lifecycle authority.
- Current AI config has no durable revision/CAS protocol. Saved config, compiled profile and running backend can differ. Current Admin activation remains disabled through core/ai-activation.js.

## Proposed request and authority contract

Versioned request: {version:1, operationId:<UUID>, expectedRevision:<nonnegative safe integer>, profileDigest:<SHA256>}. The approved profile includes exact GGUF path + content hash, executable/dependency manifest, launch args, GPU identity, context, parallelism and resource qualification. No key contents, free-form paths, shell strings or arbitrary launch arguments in the activation request.

Requested model is resolved from the immutable profile for that exact revision; never from mutable current config after acceptance. Durable AI configuration revision is distinct from conversation revisions. Add compare-and-swap saving and atomic snapshot storage before integration; digest prevents unnoticed edits. Save remains separate from activation.

Node must revalidate original admin session and admin role immediately before dispatch, enforce same-origin/CSRF protections, and bind actor + operation + revision to a short-lived authenticated request. Supervisor must authenticate the Node management peer separately. Proposed Windows transport: local named pipe with exact operator/coordinator SID DACL and peer token verification, bounded versioned messages, nonce/sequence anti-replay. Do not use the inference API key as management authorization. Same-user compromise remains outside this boundary. Exact transport needs fixture qualification and separately approved deployment permissions; not implemented here.

Supervisor is sole operation owner. Under its existing installation lifetime lease, serialize manual activation with stop, recovery and startup; validate an operation ID and reject conflicts (409) before effects. Retain completed operation results for replay rejection/idempotent status lookup. No new PID file, second supervisor, or separate competing process lock. Read-only web status must never confer control.

Before shutdown, under this lock: validate fresh authenticated request, immutable revision/profile digest, profile qualification, original retained-handle identity and expected listener. External/unverified backend => blocked; no adoption, termination or takeover. Repeat identity at each destructive boundary. Pause automatic recovery for explicit activation so it cannot restore the old profile mid-switch. Node application process remains untouched.

## Transaction and completion

1. Prepare and verify selected approved profile and all dependencies before disrupting the current backend; record operation and previous profile reference.
2. Cooperative STOP only via current broker. 10s shutdown budget initially, subject to qualification. Incomplete stop => blocked, retain authority/lease; no replacement, force, PID fallback or automatic retry.
3. Require retained-handle exit, pipes drained/closed and listener release. Close old broker cleanly; recheck absence. Keep supervisor lifetime lock across the broker handover.
4. Create exactly one replacement through the same broker architecture and a preapproved pinned profile. Changing fixed-profile selection is a required broker/build-interface change, not permission to accept arbitrary commands.
5. Absolute 300s startup budget starts before creation. Bound every observation/network wait to remaining time. Late/uncertain launch or IPC timeout => unresolved/blocked, keep lock and no retry. Timeout is not proof of process absence. Production synchronous creation semantics require separate qualification.
6. Require fresh retained-handle identity + listener ownership, authenticated health, and actual model evidence. Correlate the broker-pinned model path/hash with its launch evidence and authenticated model API identity. An alias or basename alone is insufficient. Define alias mapping explicitly or report unverified. Verify identity again after HTTP observation to detect replacement. Generalize GPU readiness per approved profile, not fixed layer 37.
7. Only report activated when all evidence agrees with the captured revision/profile. Status includes operation ID, configured revision/model, running verified revision/model, stage, fixed error code and pending change. HTTP 202 is permitted only after authenticated supervisor acknowledgement; completion is separate. Disabled/unavailable =>503, conflict/stale revision=>409, unauthorized=>401/403; never forward raw broker exceptions.

## Failure, recovery and audit

Authentication/security/configuration/model mismatch: fail closed, no retry. Failed startup with retained live child remains owned for separately authorized cooperative cleanup; never discard authority. Known child exit and listener release allow an explicit recovery decision, not an implicit second launch.

Default activation rollback is manual and disabled. If later approved, rollback must itself be one serialized, bounded operation to a still-qualified previous profile after verified replacement cleanup. Partial recovery must report requested activation failed and actual running profile, never mark requested revision active. Supervisor crash/stale lease requires reconciliation; do not infer ownership from records or reclaim automatically.

Audit allowlist: timestamp, operation ID, authenticated actor ID, profile digest/revision, fixed state/error code, durations, verified process identity metadata. Never log request bodies, prompts, output, cookies, key values, authorization headers or raw exceptions. Durable journal/write security, crash consistency and bounded retention require qualification; status records are not authorization.

## Offline implementation and tests

Added test/support/activation-contract.cjs: pure TEST-only admission/replacement/completion predicates. Inputs simulate trusted observations; booleans and object tokens are NOT real authentication or Windows handles. No I/O or providers execute effects. Contract checks complement existing lifecycle policy; they do not implement another state machine.
Added test/activation-contract.test.js: 15 tests including concurrent lock contender, replay, stale revision/profile, external owner, lost handle, foreign listener, revoked admin, future evidence, incomplete shutdown, startup failure/timeout, model mismatch and partial recovery. Existing lifecycle policy tests cover actual simulated transition ordering and start/stop/restart races. These do not establish live cross-process locking, IPC authentication, real graceful shutdown or durable recovery.

## Minimum next stages / qualification gaps

1. Approve the revision/profile and authenticated IPC contract; implement isolated durable config/CAS tests without production migration.
2. Qualify management channel authentication, bounded parsing, replay rejection, crash behavior and poisoned-channel handling with harmless fixtures. Integrate one serialization point into existing supervisor, not a web process manager.
3. Extend approved fixed-profile selection and broker handover; fixture-test races with recovery/stop, disconnects and partial failure. Ensure late timed-out replies can never authorize another command.
4. Qualify actual GGUF identity + generalized GPU readiness, owned cooperative shutdown, replacement and rollback under explicit maintenance approval. Existing external backend must not be used as an owned test subject.
5. Only after all qualification gates pass, separately authorize deployment and Admin integration. No flag flip alone makes this safe.

Recommendation: NO production activation trial yet. Next safe task is isolated authenticated management-channel and operation-serialization qualification with harmless fixtures, plus agreement on durable AI configuration revisions. Existing services, legacy tasks, production credentials and staged supervisor remain unchanged by this task.
