# TEST-only lifecycle policy contract

`core/lifecycle-policy.js` is an event-driven simulation successor to the
start-only contract in `C:\AI\scripts\chatbot-lifecycle.ps1`. Neither engine is
connected to production. The existing PowerShell engine and TEST gate are
unchanged. Do not run both as lifecycle authorities: future integration must
select one policy authority and adapt its platform observations/effects.

The PowerShell engine's launcher ancestry, boot evidence, record persistence and
thread-affine mutex are not a retained-child supervisor. This module reuses its
fail-closed invariants: complete/stable evidence, immutable instance association,
fresh final observations, explicit operation identity, bounded monotonic time,
one attempted launch per operation, and sanitized outcomes. Existing provenance
tests remain applicable to a future Windows evidence adapter. Original
start-engine test fixtures were not found in the inspected scripts/TEMP paths;
new deterministic fixtures cover the successor's invariants.

## API

`createTestLifecyclePolicy({mode: 'TEST', now, policy})` returns `dispatch(event,
observation)` and `snapshot()`. There are no imports, OS calls, timers, processes,
network requests, stored records or production providers. The caller supplies
monotonic milliseconds and advances fake time explicitly. Each instance is one
simulated installation, not a cross-process lock.

Events: `start`, `stop`, `restart`, `observe`, `tick`, `launched`, `cancel`, and
`force-stop`. Operations have instance-local monotonically numbered IDs.
Overlapping requests return `busy` with no effects. `cancel`, `launched`, and
`force-stop` must match the current operation ID. Outcomes and effects contain
only engine-generated reason codes, counters and IDs, never raw provider data.

Effects are `simulate-launch`, `simulate-clean-stop`, `simulate-force-stop`.
They are **not process-management authorization**. The caller must never wire
them to real process operations in this stage. A TEST flag cannot sandbox
untrusted injected JavaScript.

Observations require `complete`, `stable`, increasing `sequence`, fresh
`observedAt`, `process` (`absent`, `alive`, `exited`) and `listener` (`absent`,
`owned`, `foreign`). Owned observations must include the same opaque object token
returned in a matching `launched` event and `identityVerified: true`. PID/path/name
claims cannot create ownership. Only trusted fake providers may issue tokens;
real retained-handle verification is deliberately unimplemented.

Health values are `ok` and `retryable-failure`. Authentication, configuration and
security failures use the `failure` field and block recovery. Missing/ambiguous
health in a running state blocks. Shutdown requires both verified exit/absence
of the retained instance and listener release. A foreign listener always blocks.

## State and deadlines

The exported transition table covers stopped, starting, ready, degraded,
stopping, backoff, failed and blocked. Blocked is latched for that engine instance;
manual review and fresh initialization are required, not a hidden reset command.
Failed can accept an explicit start only after verified absence; an owned living
process must first be stopped. Incomplete shutdown retains the operation, so
competing requests remain busy. A separately approved force-stop simulation is
eligible only with fresh matching handle evidence. Clean-complete,
forced-complete and incomplete shutdown are distinct diagnostic values.

Startup deadline starts when launch effect is issued, including simulated
creation time. Late launch acknowledgements cannot become ready. Unknown launch
completion blocks; known-owned startup timeout fails without silently killing
the instance or starting another. Cancellation suppresses recovery; unresolved
launch/shutdown cancellation blocks rather than pretending completion.

Defaults: startup 300000 ms; shutdown 10000 ms; observation age 2000 ms;
three consecutive health failures; recovery disabled; at most three recovery
launches in a rolling 900000 ms window; backoffs 5000, 15000, 60000 ms.
All are configurable. Budget counts recovery launch effects (including failed
attempts), not initial/manual starts. Exhaustion is terminal until explicit
action. A later explicit start does not erase recent recovery launches.
The backoff schedule is indexed by recovery launches still in the window.
Deliberate stop suppresses recovery until an accepted explicit start/restart.

## Future integration prerequisites

No mutex, secure storage, boot binding, runtime ownership verification, graceful
Windows shutdown mechanism, or orphan cleanup is implemented here. A future
adapter needs bounded observations, durable retry policy across coordinator
restarts, cross-process exclusion and secure records. The qualified launch spec
can become an input to that adapter; this policy deliberately consumes no paths,
API keys, model config or executable capabilities. Production rollout requires
separate review; do not remove the TEST restriction to achieve it.
