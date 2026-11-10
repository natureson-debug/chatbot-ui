# Restart button: ownership gate only — production restart BLOCKED

The Admin Settings button uses the existing POST `/api/admin/ai/restart` route.
It requires confirmation, submits no paths/arguments/configuration, and suppresses
duplicate clicks. Authentication and administrator checks precede same-origin
validation and an explicit custom action header. No permissive CORS is added.
Audit output contains only a fixed event, outcome and code.

The existing blocked activation contract remains authoritative. Node has no
retained ownership handle for the currently external backend. The release
supervisor is inactive and its qualification flags remain false. It must not be
activated or bypassed simply to make this button succeed. Neither legacy task
helpers nor PID/name/port-based termination are used.

Expected current result: HTTP 503, LIFECYCLE_ACTIVATION_DISABLED, ownership
unverified; UI displays Ownership unknown. No process or configuration changes.
An uncertain transport result or acceptance-only response never becomes success
and keeps the button disabled pending operator review. This is not a working
managed restart service, operation journal, or graceful shutdown implementation.

Before enabling real restart: qualify and connect the existing retained-handle
supervisor's authenticated management contract, shared operation lock and
server-owned operation status; perform an explicitly approved transition from
the external foreground backend into managed ownership. Qualify shutdown, port
release, saved-config launch, GPU readiness, actual model/context verification,
timeouts and failures independently of browser lifetime. Preserve Node/SQLite
and do not adopt existing processes. No such production transition was performed.

Tests exercise UI confirmation/duplicate suppression, request-origin validation,
existing route authentication and fail-closed ownership rejection. Real managed
shutdown, replacement and readiness remain UNVERIFIED; simulations are not
production qualification. No new process-management authority was created.

## Windows lifecycle preparation

The observed production backend is still unmanaged: the `llama-server.exe`
listener has a PowerShell parent whose command line starts `server.js`, while
the only matching scheduled task is the disabled Admin Restart task. Its script
targets a separate `AI Chatbot - llama.cpp` task that is not installed. The
legacy startup and watchdog scripts also reference a llama.cpp executable under
an old Downloads directory, not `C:\AI\llama.cpp`. None of these is a verified
authoritative owner.

The installed server supports `--api-key-file`; the configured key file was
verified to match the currently running inline key without displaying either
value. The saved AI configuration contains the observed model, 32,768 context,
one parallel slot, 45 GPU layers, and metrics enabled. The configured
`buildLlamaLaunchSpec()` now includes a validated `--n-gpu-layers` value when
present. This builder is not connected to a production lifecycle service and
does not make the legacy scripts or existing process safe to manage.

### Required controlled migration

1. Keep the existing process and task state unchanged until the actual owner
   and its reproducible startup command are established. Qualify the managed
   supervisor, its retained process handle, protected ownership record, shared
   operation lock, startup readiness checks, and recovery behavior first.
2. Verify the executable, model, saved launch settings, API-key-file content
   and ACLs against the intended managed launch. Confirm the supervisor can
   reproduce the model, host/port, context, GPU layers, parallel slots, metrics,
   and file-based API authentication. Do not use the stale legacy scripts.
3. In an approved maintenance window, prevent new inference submissions and
   freshly query authenticated `/slots`. Abort if any slot is processing or
   if process identity, listener ownership, or the startup owner is ambiguous.
4. Drain requests and use only the verified current owner's graceful stop
   mechanism. Do not adopt or terminate the unowned process by PID, name, or
   port. Confirm that exact process identity has exited and the expected port
   is free before the qualified manager starts a replacement.
5. Start through the managed supervisor and require retained-handle identity,
   exact listener ownership, authenticated health/readiness, and model/context/
   GPU/slot verification before declaring success. On any failure, use only
   the supervisor's separately qualified recovery path; never kill an
   unverified process or restore an older database/configuration automatically.
6. Confirm the existing Node application can reach the same authenticated
   backend. Keep the Admin activation guard blocked until every prerequisite
   above is production-qualified.

The present installation is **not ready** for administrator-controlled server
operations. The current owner and graceful stop path are unresolved, the
scheduled-task target is missing, the legacy launch path is stale, and the
retained-handle production adapter and recovery behavior remain unqualified.
