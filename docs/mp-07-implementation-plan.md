# MP-07 implementation plan

## MP-07.2C — Optional Inference Server Management

Recorded: 2026-11-06 (Asia/Dubai).
Status: **Future requirement only; deferred, not implemented or activated.**
This item is explicitly outside MP-07.2A. Recording it does not authorize
production management, removal of activation gates, or remote administration.

### Objective and required behavior

Provide optional inference connection and lifecycle management in
**Admin → Configuration** without requiring an installed local inference engine.

1. When llama.cpp or Ollama is configured, show its relevant connection and
   management information. Distinguish saved configuration from actual running
   configuration and readiness; saving must never imply activation.
2. Authorized administrators can save valid provider connection configuration
   independently of lifecycle availability, ownership or backend reachability.
   Retain existing validation and credential protections.
3. For qualified, locally managed llama.cpp instances, support runtime
   configuration saving, Start, graceful Shutdown, Restart, and current process
   and readiness status. Runtime configuration saving must not implicitly restart.
4. Investigate equivalent local Ollama management on Windows and macOS before
   implementation. Support only operations with demonstrated safe ownership and
   shutdown semantics; do not infer authority over an independently installed
   Ollama service or application.
5. Explicitly classify each connection as:
   - External/remote provider: connection operations only.
   - Local provider managed outside the chatbot: observe where permitted; no
     automatic adoption, stop or restart.
   - Local provider launched and owned by the chatbot: only qualified operations
     backed by verified ownership and management capability.
6. Disable lifecycle controls with a clear explanation whenever ownership,
   capability, observation freshness or production qualification is unverifiable.
   A verified absent backend may be eligible for Start only through the qualified
   launch/ownership path; a foreign listener or process blocks it.
7. Never adopt or terminate unrelated processes based on PID, executable name,
   path, model or expected port alone.
8. Preserve existing lifecycle safety mechanisms and activation gates. Reuse the
   existing authority and serialization boundaries; do not create a second
   supervisor or bypass an unqualified production-management state.
9. Require server-side administrator authorization, explicit confirmation for
   destructive operations (including shutdown/restart), and sanitized audit
   records through the existing system-event database. Record operation identity,
   target and outcome without credentials, prompts or sensitive arguments.
10. Route operational success, failure and warning feedback through the planned
    centralized notification system. Maintain one primary message per event;
    controls may show persistent state but must not duplicate notifications.
11. Deny local lifecycle operations to remote LAN clients by default, including
    authenticated administrators. Remote administration requires a separate,
    explicit security qualification. Proxy-loopback peer addresses or untrusted
    forwarding headers must not be treated as proof of local-user origin.
12. Provider-only installations without llama.cpp, Ollama, CUDA or lifecycle
    helpers remain fully supported. Optional integration failure must not block
    configuration, application startup or unrelated providers.

### Existing-code dependencies and qualification boundaries

| Existing component | Intended reuse / boundary |
| --- | --- |
| `core/connections.js`, `core/provider-adapter.js`, `core/provider-models.js` | Provider validation, routing and capability separation; inference capability is not process-management authority. |
| `core/ai-settings.js`, `core/llama-launch.js` | Runtime settings and launch specification; retain explicit save-versus-activate distinction and platform qualification. |
| `core/ai-activation.js`, `server.js` activation/restart gates | Keep blocked production behavior until a qualified authority is connected. |
| `core/lifecycle-policy.js` | Reuse state, deadline, serialization and recovery contracts; currently simulation-only, not OS authority. |
| `core/llama-runtime.js`, `core/runtime/windows.js` | Existing observations/identity helpers; Windows-specific observations do not authorize adoption or termination. |
| `release/rc1/supervisor/supervisor.cjs`, `broker-client.cjs`, `src/`, `QUALIFICATION.md` | Evaluate and reuse staged retained-handle ownership, exclusion and containment; qualification artifacts are not blanket production approval. |
| `test/model-activation-contract.md`, `test/management-channel-contract.md`, `test/activation-coordinator-contract.md` | Reuse authenticated operation IDs, replay protection, immutable configuration binding and shared serialization. |
| `core/application-lifecycle.js`, `core/shutdown-coordinator.js`, `core/lifecycle-orchestrator.js` | Coordinate application shutdown with owned operations without treating external inference as an owned child. |
| `core/restart-request.js` | Existing browser-intent checks are a foundation, not sufficient proof of local administration through a proxy. |
| `core/system-logs.js`, `core/system-log-routes.js` | Existing structured system-event logging and access control; no parallel operational log database. |
| Planned centralized notifications | Required presentation dependency; MP-06A remains design-only and does not authorize lifecycle behavior. |

### Implementation order and release gates

1. Complete provider-only startup and optional-integration boundaries independently
   of this item. Define management classification and read-only capability/status.
2. Qualify the existing ownership adapter with harmless fixtures, including
   foreign processes/listeners, stale identities, concurrent operations, lost
   ownership and interrupted shutdown. No PID-only fallback.
3. Define trusted local-administrator admission and confirmation, shared operation
   serialization, audit outcomes and notification integration.
4. Add disabled-by-default UI controls driven by verified capabilities, while
   testing that connection saving works independently.
5. Separately approve and qualify controlled local llama.cpp management. Verify
   exit and listener release before replacement; block on uncertain outcomes.
6. Research/qualify Ollama per OS; keep unsupported operations unavailable.
7. Consider remote administration only as a separately approved security project.

Acceptance must cover provider-only installation, independent saving, all three
ownership classes, unauthorized/remote requests, confirmations, concurrent calls,
graceful shutdown failure, audit redaction, and nonduplicated notifications.
Automatic recovery is not newly authorized by this requirement.

### Open decisions

- Which staged ownership/broker components meet production qualification?
- Which Windows/macOS Ollama operations can be safely supported?
- How will local administration be authenticated independently of proxy topology?
- What is the centralized notification contract and operation correlation model?

No production code, configuration, database, tasks or services are changed by
this plan entry. Implementation requires a subsequent scoped task.
