# Task 27.18 — harmless Windows replacement qualification

## Files and execution

Added fixture-replacement/fixture.cpp, broker-client.cjs and qualify.cjs. Extended activation-coordinator.test.js with four injected-failure tests. No staged supervisor/native broker or production files changed.

Opt-in command (normal non-elevated operator, MSVC/SDK already installed):

    node test/fixture-replacement/qualify.cjs --run-harmless-fixtures

The harness compiles an inert x64 native HTTP fixture and uses the EXISTING staged build.cjs and src/broker.cpp to compile two pinned fixture profiles in a new TEMP directory. The native broker enforces the existing operator SID and non-elevated token. No production profile is built or run. Build artifacts stay outside the repository. Startup expires independently after 15 seconds; CTRL_C in the broker private console requests cooperative stop. Ports are ephemeral loopback and explicitly exclude 443/3000/8080/18080. Synthetic key/reference data is unused for HTTP fixture access and deleted after tests.

The test-local broker-client copy differs by permanently poisoning command submission after an exception/timeout. No late reply can authorize a new request on that client. It does not modify the staged client; production timeout remediation remains outstanding. Private-pipe closure remains cooperative cleanup of the owned fixture, not PID-based termination.

## Actual replacement sequence

Harness retains an installation experiment lease throughout; native broker holds its service lease and original CreateProcessW handle. Canonical executable/model fixture paths and SHA256 pins are approved in the existing temporary revision store. Fixtures report fixed model IDs fixture-a/fixture-b; these map to pinned synthetic GGUF files and are NOT actual GGUF parsing/model-loading evidence.

Original launches via native broker, returns PID/creation stamp, verifies executable through retained handle and confirms its TCP listener. The opaque JS ownership token is mapped to that exact broker session, never reconstructed from PID. Replacement is requested only through the existing loopback HMAC coordinator. It checks revision/digest and retains the existing configuration transaction/serialization boundary.

STOP goes through the original private broker. Only original exit + output closure + listener release permit QUIT and replacement START. Replacement broker is pinned to the approved fixture-b command. Retained-handle STATUS precedes and follows bounded HTTP health/model checks. Creation identity/listener must remain consistent. Coordinator verification uses the pinned profile mapping. Both fixtures are cooperatively stopped, broker exits awaited and the test listener re-bound to verify release. No arbitrary process adoption or kill method exists in this path.

Final native run: root C:\Users\Admin\AppData\Local\Temp\chatbot-profile-test-iHm5nv; port 52935; original PID15880 creation stamp134372121207931400; replacement PID17292 creation stamp134372121212488856. These are historical TEST identities, never future cleanup authority.

## Results (2026-10-23 client date)

112 distinct JavaScript tests passed (coordinator, profile store, management channel, activation contract, lifecycle policy, launch, disabled Admin activation and Windows provenance).
10 existing staged native tests passed: retained identity/cooperative stop, competing brokers, occupied listener, incomplete stop, supervisor disconnect, child crash, stale lease, absence of PID kill API, broker crash surviving child, actual supervisor crash cleanup. Native root: C:\Users\Admin\AppData\Local\Temp\chatbot-owned-test-cL23uM.
Final replacement experiment passed six assertions/checkpoints: foreign listener preserved; original ownership; cooperative exit/streams/listener; authenticated replacement/model verification; replacement cleanup; port release. Count these as one integrated experiment, not six independent tests. Earlier run repeated five of these checks; not counted twice.
Initial compile attempt failed due to an incorrectly quoted object-file output path; corrected before any fixture launched. Final builds and all tests passed. Syntax and git diff --check passed.

### Failure evidence boundaries

- External listener: native rejection with listener left intact. External process ownership: injected coordinator rejection, no effects.
- Invalid identity/handle mismatch: injected rejection plus native same-handle checks; no deliberate OS PID reuse forced.
- Concurrent activation/stale config: integrated authenticated/SQLite tests.
- Shutdown timeout: actual native ignore-signal fixture self-expires; no forced kill.
- Listener release failure: injected contract evidence blocks replacement; no real lingering socket was manufactured after native exit.
- Startup failure: injected coordinator provider failure; no real native replacement-start failure in the new flow.
- Health timeout, model mismatch, late broker response, interruption: deterministic injected tests. Existing native supervisor/broker crash tests are additional evidence, not a crash-safe replacement proof.

## Cleanup and recovery

New-flow test processes/brokers exited; ports 52935 and 55352 were independently observed free. No PID termination or process-tree kill used. Synthetic key, revisions.sqlite and released experiment lease removed from final and prior successful fixture roots. Compiler outputs, fixed synthetic model artifacts and sanitized build logs retained for review. Existing native suite intentionally retains stale test leases for crash evidence; they do not govern production.

Before shutdown: rejection preserves original ownership; harness cleanup cooperatively stops only its fixture. After original exit: startup failure leaves backend absent and incomplete activation blocks retries. After replacement start: verification failure retains unresolved state; cleanup belongs to the exact owned fixture broker. A poisoned client is not reused; disconnect permits broker cooperative cleanup, and independent fixture expiry bounds failure cleanup. If exit cannot be confirmed, report cleanup unverified rather than killing by PID. No automatic rollback or recovery.

## Qualification gaps / readiness

This proves one native replacement through existing ownership architecture, not a production activation system. Still required: protected management IPC/peer authentication, secure durable operation markers/rollback detection, production broker timeout poisoning, actual GPU/model readiness and safe real shutdown, long-duration deadlines, supervisor lifetime lock integration across profile handover, native startup/health/model-mismatch failure-path qualification. Raw compiled per-profile service leases differ; experiment-wide lease is held by the harness only. Do not mistake that for completed production supervisor integration.

Recommendation: NOT ready for controlled production integration. Ready for review and broader isolated native fault-path qualification. No services, llama.cpp, production credentials/databases, Scheduled Tasks or network/firewall configuration were changed. No commits/pushes.
