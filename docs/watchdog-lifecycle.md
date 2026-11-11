# MP-GPU-02E watchdog candidate — not deployed

`scripts/chatbot-watchdog.ps1` is a repository candidate. The production script
at `C:\AI\scripts\chatbot-watchdog.ps1` and scheduled tasks are unchanged.
It reuses the installed `Global\Chatbot.LlamaLifecycle` lock and shared evidence
collector/argument builder. Both ownership validators remain unchanged.

States are `healthy`, `starting`, `unhealthy`, `absent` and `uncertain`.
Healthy requires trusted task action, sole backend/listener, executable/parent/
creation identity, exact saved arguments and authenticated HTTP 200 health with
`status: ok`. Evidence and configuration are checked again after HTTP. Redirects
are disabled; HTTP has a two-second default timeout. Loading/503 is provisional,
never success. An expected process awaiting a listener while its task runs is
also provisionally starting. All unhealthy or uncertain existing processes are
left alone. No termination mechanism exists in this candidate.

Only repeated successful absence checks under the lock permit one request to
start the existing `AI Chatbot - llama.cpp` scheduled task. Recovery is refused
if the task is disabled, not Ready, has an unexpected action, or if any backend
or port-8080 listener exists. Busy/abandoned/unverifiable locks authorize nothing.
No direct launcher process is created; no task is enabled or disabled.

Before that request, an exclusive create writes the durable admission marker
`C:\AI\logs\watchdog-recovery.pending`. Existing markers or write failures block
recovery. Only verified successful readiness removes the marker. Task-call
failure, process interruption or timeout leaves it present, blocking subsequent
watchdog invocations. Logs contain fixed state/reason codes, not exceptions,
command lines, keys or response bodies. The key is read only for health checks.

## Separate production-validation procedure

1. Keep watchdog disabled. Checkpoint the current script; review this candidate.
   Verify the runtime account can read task/CIM evidence and the key file and
   write the protected logs directory. Unrelated users must not control scripts
   or the recovery marker.
2. Run the separately approved read-only diagnostic:
   `. 'C:\AI\chatbot-ui\scripts\Test-ChatbotLiveBackendOwnership.ps1'; Test-ChatbotLiveBackendOwnership`.
3. Read-only candidate observation, with no lock, logging or recovery:
   `. 'C:\AI\chatbot-ui\scripts\chatbot-watchdog.ps1'; Get-ChatbotWatchdogObservation`.
   Verify dual-GPU configuration and health. Do not enable the task.
4. Separately approve deploying this script and its shared helpers, or having
   the existing production script invoke the repository candidate. Preserve the
   task identity/action and lock. Running the candidate entry point can start
   recovery; dot-source it for read-only observation instead.
5. Qualify recovery only in a separately approved maintenance window. Confirm
   the task execution limit exceeds the startup deadline plus observation
   overhead: the previously inspected task has a one-minute limit, whereas the
   candidate defaults to 300 seconds. No settings were changed here.
6. Never blindly delete a pending marker. Under the existing lifecycle lock,
   first exclude in-flight task/process launches and inspect listeners/settings,
   then explicitly authorize manual reset. Rollback restores the reviewed old
   script while keeping watchdog disabled and preserving the marker for review;
   it does not stop a backend.

## Limits

Tests use synthetic CIM/task/HTTP observations, clocks and latch state. They do
not qualify real SYSTEM permissions, scheduler behavior or marker persistence
after a machine crash. HTTP is bounded; the overall deadline is checked around
synchronous observations, not a hard interruption of a hung Windows API. A killed
watchdog leaves its marker. Protected storage and cooperative use of the lock
are prerequisites: unrelated launchers that ignore it can race absence checks.
This is observed provenance, not retained-handle ownership. Hardware enumeration
is not launched; saved arguments and runtime health are verified. No production
process, configuration, task or watchdog activation was changed for this work.
