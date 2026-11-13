# Offline watchdog release builder (MP-GPU-03F-2)

This is staging infrastructure, not a deployment tool. It never invokes PowerShell,
tasks, watchdogs, inference, ACL mutation or credential APIs. Production integration
and native permission qualification remain blocked. No production inputs are read
automatically. No keys, snapshots, models, runtime binaries or configuration contents
are copied. Only seven explicitly approved PowerShell sources are included.

## Inputs and manifest v1

`node scripts/watchdog-release.cjs build <plan.json> <existing-temp-parent>`

The parent must be an absolute existing descendant of the OS temporary directory.
The release directory must not exist. Symbolic links/junctions detected by Node
are rejected along its ancestry. No protected deployment directories are written.
On write failure a partial directory may remain: it is not valid or reusable.

The plan has exactly these properties:

* `releaseId`: 1–64 ASCII letters, digits, underscores or hyphens, starting alphanumeric.
* `sourceCommit`: 40 lowercase hex characters identifying the reviewed repository commit.
* `sources`: exactly the seven names exported by `FILES`, each with an absolute
  local `path` and reviewed lowercase SHA-256 `sha256`.
* `paths`: `scripts`, `runtime`, `executable`, `config`, `models`, `logs`.
  These are explicit final Windows absolute paths, not staging locations. Runtime
  must contain `llama-server.exe`; directory roots must not overlap. Shell/string
  injection characters, relative paths and noncanonical paths are rejected.
* `runtimeDependencies`: nonempty array of `{path,sha256}` for the executable and
  every approved adjacent DLL. These are references only, never copied/read by
  the builder. A trusted runtime inspector must establish completeness later.

Example path profile (not an activated configuration):

```json
{
  "scripts": "C:\\Program Files\\Renitech\\Watchdog\\releases\\v1",
  "runtime": "C:\\Program Files\\Renitech\\Watchdog\\runtime\\b11609",
  "executable": "C:\\Program Files\\Renitech\\Watchdog\\runtime\\b11609\\llama-server.exe",
  "config": "C:\\ProgramData\\Renitech\\Watchdog\\config",
  "models": "C:\\ProtectedModels",
  "logs": "C:\\ProgramData\\Renitech\\Watchdog\\state-and-logs"
}
```

The current scripts share a configuration directory for settings and the key-file
reference, and one directory for logs and the recovery marker. This first builder
preserves those relationships; separating them requires a later reviewed script
change. No live marker may be reset or silently lost when those paths change.

The allowlist is `chatbot-watchdog.ps1`, `chatbot-owned-backend.ps1`,
`chatbot-backend-evidence.ps1`, `Restart-ChatbotAI.ps1`,
`Test-ChatbotLiveBackendOwnership.ps1`, `chatbot-lifecycle-lock.ps1`, and
`start-chatbot-ai.ps1`. The last two production sources are not currently tracked
in this repository. An operator must supply reviewed offline copies and hashes;
tests use harmless substitutes. Source commit is provenance metadata, not proof
that external inputs came from Git. Their individual hashes are authoritative
only when approved independently.

The builder replaces the known legacy path prefixes in copies. It does not
rewrite task names, flags, mutex SID policy, argument matching or process identity
checks. It rejects remaining known legacy prefixes. Exact task actions must use
the resulting versioned paths. There is no repository wrapper dependency.
Source review must approve imports and dependency closure: hashes cannot prove
that an arbitrary script is safe. Do not approve sources containing embedded
secrets. Pattern scanning is defense in depth, not a universal secret detector.

### Deterministic enumeration (MP-GPU-03F-5A)

In addition to path substitutions, staged `chatbot-backend-evidence.ps1` and
`start-chatbot-ai.ps1` each receive a guard around their one `--list-devices`
invocation. A missing or changed recognized source call aborts the build. The
guard pins the executable and runtime to the approved path profile, rejects
missing paths and direct reparse points, uses terminating `Push-Location`, and
restores the caller location with `finally`. Invocation errors/nonzero exit codes
fail; there is no inherited-working-directory fallback. GPU parsing, selection,
launch arguments, locking and ownership predicates remain unchanged.

`test/staged-gpu-enumeration.ps1` parses the actual staged scripts and exercises
their generated guard with only the native invocation and filesystem/location
observations mocked. Sixteen cases cover both sites. It never executes llama.cpp.
The release tests also verify syntax, hashes and source-drift rejection. Actual
installed launcher copies were staged offline and passed the same 16 cases plus
the existing ownership fixtures and 58 injected watchdog assertions.

These checks do not qualify native DLL resolution, SYSTEM access or ancestor
TOCTOU protection. The validator still returns `security-unverified` without a
qualified native evidence provider. No installed script is changed by this fix.

`manifest.json` contains exactly `schemaVersion:1`, `releaseId`, `sourceCommit`,
`paths`, `entryPoints` (watchdog/launcher fixed names), `lockIdentity`
(`Global\\Chatbot.LlamaLifecycle`), `files` (path/output SHA-256/source SHA-256),
and `runtimeDependencies`. No source filesystem paths are persisted. The builder
returns the manifest SHA-256; store its reviewed pin independently of the release.

## Validation and trust boundary

`node scripts/watchdog-release.cjs validate <release-root> <trusted-manifest-sha256>`

The CLI checks schema, exact contents, hashes, entry points, paths, mutex identity
and secret patterns, then **fails `security-unverified`**. It does not accept a JSON
file claiming permission success. There is no production approval shortcut.

The library accepts trusted synchronous `inspectSecurity(path)` and
`inspectRuntime(path)` providers for isolated tests/future native integration.
Security evidence must bind the exact path and positively establish ancestor and
effective-access inspection, no reparse point, no untrusted write and no replacement
authority. It covers every release file, manifest, configured root and declared
runtime file. Runtime evidence must establish a regular file, matching SHA-256
and complete dependency inventory. Missing evidence fails closed.

Success is explicitly labeled `injected-evidence-only`. The fake providers in the
tests are not Windows ACL qualification. Node lstat checks do not prove absence of
all Windows reparse variants, hard-link attacks or TOCTOU races. No file-handle
relative deployment transaction is implemented. The native provider must account
for owners, token/group membership, deny ACEs, inheritance, Delete Child, ACL/owner
rights and replaceable ancestors, including code and DLL search locations.

## Proposed promotion and rollback (not executed)

1. In a later approved maintenance procedure, export task definitions/security,
   record original process identities, configuration references, ACLs, source and
   binary hashes. Protect the checkpoint; do not include key contents in reports.
2. Build into Temp with reviewed offline source copies. Review manifest and exact
   transformed script diffs. A build is not a deployment qualification.
3. Supply a separately qualified native security/runtime inspector. The current
   CLI cannot pass this gate, so **do not copy or activate on its result**.
4. Once that gate is implemented, an elevated promoter must create a new protected
   version directory, copy only approved files, rehash and revalidate at destination.
   Never execute Temp scripts. Preserve the lifecycle lock and marker semantics.
5. Task updates and backend replacement need separate approval and the migration
   plan's shutdown/identity checks. Do not broaden ancestry acceptance for the
   still-running legacy backend. Keep recovery paused on uncertainty.

Preparation command templates only:

```powershell
node scripts/watchdog-release.cjs build '<reviewed-plan.json>' '<existing-temp-parent>'
node scripts/watchdog-release.cjs validate '<staged-release>' '<independently-approved-manifest-hash>'
# Expected until native integration: security-unverified, exit 1. STOP.
```

Rollback selection uses the same validation:
`selectRollback(previousRelease, pinnedManifestHash, trustedProviders)` returns
only the validated selection; it does not copy, activate, execute or change tasks.
Run the same CLI validation command against the previous release/pin first.
There is deliberately no deploy/rollback mutation command in this phase. A later
promoter must restore matching protected release/task references, never silently
restore the writable SYSTEM execution chain. No valid previous release means stop
and keep automation paused, not bypass validation.

## Qualification limits

Focused tests use temporary copies, actual repository validators, synthetic
launcher/lock scripts and mocked Windows evidence. They do not qualify the real
launcher, DLL inventory, native ACLs, SYSTEM module search, deployment ancestry,
API-key access, GPU initialization or task execution. Git/Codex and non-elevated
Node remain unchanged. Production configuration save semantics and distinct
secret/state roots remain migration decisions before activation.
