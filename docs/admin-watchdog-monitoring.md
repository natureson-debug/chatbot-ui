# Read-only watchdog monitoring (MP-GPU-03A)

Admin → Server monitoring includes a watchdog card. `GET /api/admin/watchdog/status`
requires an authenticated administrator before collection/cache access and again
after collection using the original session token. Other methods are denied.
No lifecycle actions or configuration controls are exposed.

The Windows adapter executes a fixed PowerShell collector asynchronously, with
an eight-second timeout and 32 KiB output limit, and shares one in-flight sample.
Results (including failures) are cached for 15 seconds. No elevated context is
requested: task/CIM/ACL restrictions under the Node account show Unavailable.
Non-Windows installations return Unsupported without invoking PowerShell.

The collector reads task state/run metadata, marker presence, and backend PID
with the existing read-only ownership/configuration diagnostic. Task info is
queried first to distinguish access denial from a definite missing-task result;
other task query failures remain unavailable. Sanitized task reason codes are
`task-access-denied`, `task-not-found`, and `task-unavailable`.

Backend verification continues to fail closed. Unavailable evidence yields null
ownership and configuration results, not a confirmed mismatch. The only false
configuration result is `configuration-mismatch` after a verified ownership
observation and comparison. Other allowlisted backend reasons are
`evidence-unavailable`, `ownership-unverified`, `ownership-changed`, and
`configuration-changed`. When ownership cannot be verified, a sole loopback
port-8080 listener PID may be displayed separately and explicitly as Unverified;
it is not proof of process identity or authority to act.
The panel labels a snapshot partial when task or backend verification is
unavailable, even when independent log and marker observations succeeded.

The collector never calls
the watchdog recovery entry point, takes a lifecycle lock, reads API-key contents,
or changes tasks/files/configuration. Identity is an observation, not termination
authority or a health claim. It does not expose process command lines or paths.

Only the last 16 KiB of the watchdog log is read. At most 12 recognized structured
observations are returned; fixed state/reason allowlists exclude arbitrary log
content. Legacy/malformed records are marked rather than rendered. Current log
entries lack timestamps: the UI explicitly labels file modification time and
does not assign it to individual events. Logs older than five minutes are stale;
this may simply reflect a disabled watchdog. Browser snapshots older than 30
seconds are marked stale. Missing timestamps/results remain unavailable.

The independent read-only panel reuses existing monitoring styles and polls at
15-second intervals with one request at a time, a ten-second browser deadline,
visibility pause/abort and page-exit disposal. Authentication failure clears
displayed data and stops polling. Fetch/parse failures clear current readings.
No database schema or persistent telemetry collection changes are involved.

Focused automated validation uses injected authorization/transport, mocked DOM,
and an isolated Windows collector with temporary log/marker files and fake
task/backend/listener observations. Native production-account access, real-browser
theme and mobile acceptance remain deployment checks.

After separate deployment approval, verify anonymous 401, regular-user 403,
administrator 200, revoked-session denial, accurate disabled/running task fields,
and explicit unavailable states when CIM is denied. Check desktop/mobile themes,
hidden-tab polling and browser errors. Do not trigger recovery to test the panel.
