# TEST-only native Windows process-handle experiment

This directory is **not a production adapter**. Nothing imports it from the
application or lifecycle policy. No scheduled tasks, production ports, model
files, API keys or databases are used. The policy's simulated effects remain
simulations and are not process-management authorization.

## Build and qualify

From a non-elevated x64 Windows operator session, with the existing Visual Studio
2022 Build Tools and Windows SDK 10.0.22621.0:

```powershell
node test/native-process-broker/qualify.js --run-harmless-fixtures
```

Without that explicit option, the harness skips. It initializes `vcvarsall.bat
x64 10.0.22621.0`, builds with `/W4 /WX /MT /MACHINE:X64`, and verifies PE machine
type 0x8664. All generated headers, objects, executables, manifests and results
go into a unique `chatbot-native-broker-*` directory under the operator's TEMP.
No compiler installation or production configuration change is performed.

The fixture executable's absolute path and SHA-256 are compiled into the helper.
There is no path, command-line, PID or network-port selection in the control
protocol. The fixture selects an ephemeral IPv4 loopback port and explicitly
rejects 8080 and 18080. It validates fixed Unicode/quoting test arguments, emits
two fixed diagnostic lines and expires independently after 30 seconds.

## Ownership and containment

The broker creates one child with `CreateProcessW`, an explicit application
path, working directory and minimal environment. It retains the returned
`hProcess`, and uses that handle for `GetProcessId`, `GetProcessTimes`,
`QueryFullProcessImageNameW`, `IsProcessInJob`, waits, exit status and authorized
`TerminateProcess`. No `OpenProcess`, adoption, PID termination or shell exists.

`STARTUPINFOEXW` supplies both `PROC_THREAD_ATTRIBUTE_JOB_LIST` and an explicit
three-handle standard-I/O inheritance list. Containment is established during
creation, before the suspended fixture's primary thread is resumed. The unnamed
job has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Neither the job nor control channel
is inherited by the fixture. Both helper and fixture reject elevated tokens.

The fixed fixture image is hash-verified while held open without write/delete
sharing. Ancestor directory handles prevent renaming while held, and reparse
points are rejected. An exclusive `CREATE_NEW` lease in the staging directory
prevents two helpers from launching this build concurrently. It is removed only
after verified normal/authorized-force cleanup; abnormal exits leave it behind.
A later helper refuses the stale lease. The harness removes test leases only
after all its helpers exit and observed ports are released; it never kills by PID.

## Private protocol

The helper requires `--test-only` and redirected pipe input/output. It sends a
version-1 handshake with a random 128-bit session token. Subsequent ASCII frames
are at most 256 bytes, newline terminated, with at most 10,000 frames per session:

`V1 <next-sequence> <session-token> <command> [argument]`

Commands: `START cooperative`, `START ignore`, `OBSERVE`, `STOP`,
`FORCE AUTHORIZE`, and `QUIT`. `CRASH_TEST` and `LOSE_HANDLE_TEST` are narrowly
scoped failure-injection commands for an already launched fixture. There is one
launch attempt per session, including failed attempts; completion cannot reset
this restriction. Unknown commands, tokens, sequences, versions and extra fields
cannot authorize termination. The token stays in the harness's memory and is
not included in result reports.

Input has a 15-second inactivity/frame deadline. Output is limited to 1 KiB per
reply; writes use a dedicated thread, a two-second wait, cancellation and at most
one additional second before self-exit. Fixture output buffers are limited to
4 KiB each. Diagnostics never forward arbitrary fixture output or request text.

## Shutdown and failure behavior

- Cooperative shutdown writes the fixed fixture-only `TEST_SHUTDOWN` command and
  waits up to 300 ms for exit, both stream closures, no active job members, and
  listener release.
- Timeout reports `incomplete`, retaining ownership and the lease. It does not
  force automatically. `FORCE AUTHORIZE` uses only the original process handle
  and allows a three-second completion wait.
- EOF, malformed oversized input, ownership failure and helper crash trigger
  the explicitly authorized **fixture-only** kill-on-job-close cleanup. This is
  forced containment cleanup, not cooperative shutdown or automatic recovery.
- A lost handle is never reconstructed from PID. A foreign IPv4/IPv6 listener
  blocks observation; it is never terminated. Abnormal cleanup leaves a stale
  lease even when fixture exit is observed.

No successful cleanup is reported until exit, output closure, job emptiness and
listener release are verified. Synchronous Windows API calls are not a hard
real-time guarantee; bounded waits do not guarantee an OS cannot stall internally.

## Qualification and limitations

The harness tests real harmless processes, private-channel/session isolation,
exclusive ownership, replay/invalid requests, quoting, original-handle identity,
cooperative/forced/incomplete stop, handle loss, helper crash, disconnect, foreign
listeners, stalled output, fixed-image tampering, repeat sessions and cleanup.
It preserves build logs, hashes and a structured result report. Exit 1 means a
failure; exit 2 means tests completed with an explicitly UNVERIFIED finding.

Current unresolved finding: total process handle count increased by three after
one child launch/cleanup despite all explicitly owned HANDLE wrappers returning
to zero with successful `CloseHandle`. A temporary self-snapshot diagnostic
identified a registry-key handle, an unnamed file handle and an unclassified
entry. Their full origin is unproven. Do not equate owned-handle accounting with
a proof that the entire process has no leaks. This blocks full leak qualification.
The diagnostic snapshot code and object names are not in the final protocol.

This controlled TEMP build is not a trusted deployment. The helper itself is
unsigned and the staging directory is writable; a malicious same-user process
can compromise a supervisor/helper. Private pipe possession and session tokens
are not protection against administrator or supervising-account compromise.
Production use would need independently protected/signed helper and DLL paths,
deployment verification, reviewed ACLs, durable lifecycle reconciliation and
an installation-wide exclusion design. None is installed here.

The fixture's stdin shutdown protocol is not evidence that llama.cpp supports
that mechanism. PID reuse is addressed by never reopening a PID; the suite does
not force Windows to recycle a particular PID. No Electron/HTTP/policy integration
or automatic restart is provided.
