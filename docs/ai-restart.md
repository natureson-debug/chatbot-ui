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
