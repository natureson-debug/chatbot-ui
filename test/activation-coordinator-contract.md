# Task 27.17 — integrated TEST activation transaction

## Architecture and changes

New support/activation-coordinator.cjs composes existing openTestChannel HMAC transport, profile-store and activation predicates. The old STATUS-only createTestBoundary is not layered on top: the coordinator supplies the channel's boundary, so there is one admission gate. Configuration saves use that same gate. No process APIs, native broker connection, executable launch or production imports are introduced. This is transaction orchestration, not a replacement lifecycle authority; injected stop/launch/verify functions produce simulated ownership evidence only. Future integration must route effects through the existing supervisor and retained-handle broker.

profile-store.cjs now adds a fixture-only activation_operations table (operation_id primary key, revision, digest, status). beginActivation atomically binds the current approved revision and commits an incomplete marker, then holds BEGIN IMMEDIATE until simulation finishes. append rejects an incomplete marker; a second SQLite connection also cannot write while the activation lock is held. The small commit/reacquire interval remains fail-closed because all store writers check the marker. No production migration is run.

Coordinator saves are a trusted in-process fixture API, not a new unauthenticated HTTP endpoint. Activation enters only through the existing authenticated, bounded loopback TEST channel. Operation IDs are bound to stored revisions/digests, replay-limited in memory and recorded durably for admitted operations. Unsupported actions are rejected. No new key delivery mechanism or Windows peer identity claim.

## State contract

Normal path: requested -> validated -> accepted -> activating -> verifying -> succeeded.
Admission errors may become failed/blocked/unverifiable. Active/verification failures become failed/blocked/unverifiable. Terminal states have no outgoing transitions. transition() rejects invalid edges. Public responses contain TEST mode, fixed code, state trace and productionReady:false, never provider exceptions, arguments or credentials.

Admission validates config/profile before and after asynchronous ownership observation. Accepted target is immutable. The coordinator captures the original simulated handle; replacement requires identity, exit, streams closed and listener release through existing contract checks. Verification compares the newly returned handle, health, listener identity and actual reported model against the STORE's model path/hash, not provider-supplied expected model values.

Timeout or interruption revokes the operation capability, poisons the coordinator and returns unverifiable. Every continuation checks capability/clock/lease before subsequent effects. Late stop replies cannot launch. No automatic rollback, recovery, retry or forced stop. If a simulated effect began, any non-success retains the incomplete marker. Only verified success commits status succeeded.

## Durability and limitations

Durable: committed configuration history, CAS revision ordering, approved-profile digests/seals, admitted operation IDs, incomplete marker and successful operation status. Successful activation is a simulated result only.

In memory: HMAC session/key, pre-admission replay set, admission gate, trace, deadlines, simulated handle identities, capability revocation. A new coordinator detects the durable incomplete marker and blocks all work. There is intentionally no automatic reconciliation/marker-clear operation. This is conservative recovery blocking, not crash-safe activation. Real process crash/power-loss testing was not performed. A provider action already issued cannot be undone by timeout.

Existing limits persist: operator trust, loopback denial of service, absent Windows named-pipe DACL/peer verification, no protected credential delivery, no whole-store rollback anchor or secure audit journal. Operation markers currently rely on fixture database integrity/permissions and are not authenticated like revision rows. Privileged modification of markers could defeat recovery blocking; production storage hardening is mandatory. SQLite locks do not substitute for the supervisor's lifetime ownership lease. A long-running transaction is appropriate for these short simulations, not yet qualified for 300-second production startup.

## Tests and assessment

New activation-coordinator.test.js uses actual loopback HMAC requests, temporary SQLite fixtures, two connections and injected deferred providers. Tests cover full trace, invalid transition, write/activation conflict, concurrent duplicate/replay, stale revision/digest, invalid authentication, unverifiable lock, timeout/late reply, interruption, incomplete recovery after reopen, model mismatch, admission-time external configuration change and incomplete shutdown.

No live OS handles/processes are used. Fixtures/listeners are cleaned up. Existing lifecycle policy, activation contract, management channel, profile-store, launch and disabled Admin activation suites remain regression coverage.

Ready for review and the next isolated harmless-fixture process replacement experiment only, with an explicit native-adapter safety contract. Not ready for production replacement. Do not pass real process providers to this TEST coordinator or clear incomplete markers to bypass uncertainty. Production integration, protected IPC, retained-handle effect binding, secure durable recovery and real shutdown qualification remain outstanding.
