# Task 27.15 — TEST management channel

## Implemented boundary

`test/support/management-channel.cjs` is opt-in TEST infrastructure, with no production imports or process APIs. `openTestChannel()` binds an ephemeral port on IPv4 127.0.0.1 only. It accepts POST /test-management, rejects browser Origin headers and other content types, limits bodies to 4096 bytes, connections to eight and socket/request/header timeouts to two seconds.

A fresh 256-bit in-memory capability authenticates exact request bytes using HMAC-SHA256; response bytes are also MAC-authenticated with a separate domain. Constant-time MAC comparison, random per-channel session identity, explicit fixture actor authorization, strict schema, bounded 30-second lifetime, operation-ID replay ledger (1024 entries, fail closed when full), configuration revision and approved profile digest are checked. Keys are not written to disk, logged, returned over HTTP or placed in arguments. The fixture client is an in-memory capability closure. A new session has a new key/session, invalidating old signed requests.

This loopback/capability transport is restricted by cryptographic access, NOT a Windows SID ACL. It is suitable for isolated qualification only. Other local users can connect and cause denial of service, but cannot authenticate without the capability. Production named-pipe DACL/peer-token checks and protected credential delivery remain unimplemented. No inference key is reused.

`createTestBoundary()` is an admission/dispatch wrapper, not a second process manager or lifecycle state machine. It consumes Task 27.14 predicates and requires injected ownership evidence and installation-lease verification. One instance is shared by all test activation/start/stop/recovery requests. It reserves serialization before asynchronous observations; no provider is called after uncertainty. This does not acquire or replace the production lifetime lease. Integration must put existing supervisor startup, stop, recovery and activation behind this same boundary while retaining its existing native ownership and lease architecture.

## Outcomes and delayed responses

Responses expose only version, TEST mode, state, fixed code and productionReady:false. States: accepted, rejected, conflicting, timed-out and unverifiable. No raw provider exception, argument, prompt or secret is returned or logged.

Accepted means SIMULATED_DISPATCH_ACCEPTED after a single injected STATUS response; it does NOT mean activation completed. No STOP or START command is dispatched by this qualification stage, regardless of the requested action.

The operation carries a deadline and revocable capability. Every provider boundary rechecks clock, expiry and lease. Broker replies must match operation ID and sequence. Timeout, protocol mismatch or provider exception permanently poisons the session and retains logical exclusion. Late evidence cannot issue STATUS; late STATUS cannot reopen the session or issue another command. Channel closure/disconnect also invalidates authority. No retry or reuse is available. Already-issued real commands could not be undone by cancellation: production integration must retain handles and reconcile uncertain effects. The staged broker-client timeout implementation is deliberately unchanged and still needs this behavior implemented and qualified there.

## Verification

`test/management-channel.test.js`: 11 tests over real ephemeral loopback HTTP with injected providers and deterministic timeout triggers. Authentication/authorization, malformed/expired frames, replay, stale revision, shared concurrent action gate, lease uncertainty, late observation, late broker reply, mismatched sequence, expiration during preflight, channel closure and unavailability are covered. No harmless child executable was needed; no processes were managed. All test listeners close in cleanup.

Combined regression command:
node --test test/management-channel.test.js test/lifecycle-policy.test.js test/activation-contract.test.js test/ai-activation.test.js test/llama-launch.test.js

58 tests passed; syntax and git diff --check passed. Existing application startup source and staged supervisor/broker were not edited or run. Production startup behavior is unchanged by construction; no live startup validation was attempted.

## Remaining gaps / next-stage recommendation

Ready for review and further isolated integration, NOT production use. Required next: protected Windows management transport and peer identity; actual supervisor-wide gate wiring; persistent configuration revision/CAS; real broker reply correlation/poisoning; bounded replay persistence and audit journal if sessions survive restarts; owned broker cleanup after channel loss; fixture cross-process recovery/crash qualification. Retained-handle, model identity and real model replacement qualification remain separate. TEST booleans/object tokens are not Windows ownership proof. No production Admin integration or activation is authorized by these results.
