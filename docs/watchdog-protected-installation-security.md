# Protected installation security specification — MP-GPU-03G-2

Prepared 2026-11-16 (Asia/Dubai). Review baseline:
`49849fd4943314bd6b736a099d7703b63e2dccd1`, branch `feature/mp-05c-deepseek`.
Status: design for administrator review; installation and activation are NOT authorized.
All creation, copy, access probes, token tests and rollback operations below are
future procedures requiring separate approval. No deployment command is supplied.

## 1. Architecture and evidence boundary

Privileged tasks execute only exact, versioned protected release paths. Writable
configuration, secrets and runtime state are separate siblings, never code search
locations. Node remains non-elevated; Git/Codex retain development-workspace access
but no protected-installation write authority. No new lifecycle authority is created.

MP-GPU-03G-1 observed: proposed AIChatbot roots absent; Program Files protected and
ordinary Users read/execute; ProgramData grants Users child creation/write and
inheritable Creator Owner access. Existing C:\AI sources grant broad Modify access.
The existing key ACL was inaccessible to the inspection token. These are dated ACL
observations, not current SYSTEM-token qualification. Recollect them before staging.

The v2 builder now separates configuration, key, logs, state and evidence paths.
The recovered launcher and lock are tracked at this baseline; see
[source provenance](recovered-watchdog-sources.md). Earlier text in
[offline builder documentation](offline-watchdog-release.md) describing them as
untracked, and the local migration-plan draft's combined-path blocker, are historical
and superseded on these points. Neither successful building nor mocked evidence
qualifies native security. Default validation remains `security-unverified`.

## 2. Identities and trust

Use resolved SIDs, never localized names or an account name such as Admin as proof
of elevation. Record enabled/deny-only groups, restricted SIDs, integrity level and
relevant privileges for every test token.

* SYSTEM: S-1-5-18, runtime reader and state/log writer; trusted privileged identity.
* Elevated Administrators: S-1-5-32-544 enabled in the elevated deployment token;
  install, promote, maintain and recover protected objects.
* Operator: installation SID, normally filtered/non-elevated; no explicit Modify,
  FullControl, WriteDac or WriteOwner on privileged inputs or ancestors.
* Node: record its actual account SID separately. It has only approved read grants;
  configuration-save requests require a future reviewed promotion boundary.
* Ordinary Users (S-1-5-32-545), Authenticated Users (S-1-5-11), Everyone and Codex
  sandbox identities: no default grants inside application roots.

If Node and the operator or Codex share an account, a SID-based grant applies to
all processes with that SID. This specification cannot isolate those processes.
Administrators and SYSTEM can override protections and are outside the untrusted
threat model. A compromised SYSTEM watchdog can change ACLs; read-only grants are
least-privilege documentation, not confinement of SYSTEM.

## 3. Exact ACL policy

Owner of every application directory and file: BUILTIN Administrators SID
S-1-5-32-544. Do not assign ownership to the interactive operator or Creator Owner.
All DACLs must be non-null, canonical and contain only the approved allow entries.
No broad deny ACEs are required: omit unauthorized grants rather than denying
groups which also contain trusted accounts.

Rights notation: F = FullControl; RX = ReadAndExecute; R = Read; M = Modify.
Directory grants include Synchronize and necessary traversal. OI/CI means object
and container inheritance. All grants apply to the directory itself and descendants
unless expressly marked root-only. No grants include InheritOnly alone.

| Directory | DACL protection / inheritance | Administrators | SYSTEM | Operator / Node / ordinary identities |
|---|---|---|---|---|
| C:\Program Files\AIChatbot | Protected; explicit OI/CI | F | RX | None by default |
| releases | Protected; explicit OI/CI | F | RX | None |
| releases\<id> | Protected; explicit OI/CI | F | RX | None |
| <id>\scripts, <id>\runtime and descendants | Inherit only approved release ACEs | F | RX | None |
| C:\ProgramData\AIChatbot | Protected; root-only explicit ACEs | F | RX | None |
| config | Protected; explicit OI/CI | F | R plus directory traversal | None |
| secrets | Protected; explicit OI/CI | F | R plus directory traversal | None |
| logs | Protected; explicit OI/CI | F | M | None |
| state | Protected; explicit OI/CI | F | M | None |
| evidence | Protected; explicit OI/CI | F | M | None |

Release files inherit F/RX; configuration and secret files inherit F/R; runtime
data files inherit F/M. No additional explicit ACEs are accepted. Child inheritance
must not introduce Creator Owner, Users, Authenticated Users or sandbox grants.
Verify every file, not just the directory. Data roots cannot overlap release roots.
Models are external inputs requiring their own read/provenance qualification.

Optional read grants are installation-profile decisions requiring approval before
qualification: named Node SID R on the exact key/config file it needs; R on specific
sanitized evidence; RX on code only if genuinely needed. Add traversal/read-attributes
on the necessary ancestor directories, root-only, not inherited broad read access.
Document the resulting exact ACE set and test it. Node never receives write access.
Do not grant access to the whole evidence directory merely to expose a sanitized
report: checkpoints may contain sensitive security metadata. Ordinary users and
Authenticated Users receive no key access. Protected GUI or environment credentials
are not migrated by this plan.

SYSTEM M on logs/state/evidence permits file creation, update and deletion required
by existing behavior; it does not grant WriteDac or WriteOwner. Recovery-marker
deletion remains governed by lifecycle semantics, not merely by filesystem rights.
Release immutability means no runtime/untrusted modification and no in-place edits
by deployment workflow; elevated Administrators retain maintenance authority.

## 4. Pre-creation threat model and installer safeguards

ProgramData child-creation rights allow an ordinary user to win a race to create
AIChatbot, own it and place files or junctions beneath it. Root existence is not
trust. Program Files is not automatically trusted merely by path spelling either.

The future elevated installer must:

1. Use absolute canonical local paths and a fixed approved layout. Reject traversal,
   alternate data streams, ambiguous names and unapproved redirects. Validate the
   volume, each ancestor and the leaf through native handles and file identities.
2. Inspect owner, protected/inherited DACL, effective token permissions and reparse
   attributes at every component. Reject all junctions/reparse points, unexpected
   hard links for privileged files and unknown security information.
3. If either vendor root already exists, require a prior trusted installation record,
   matching identity and fully qualified security. Unknown ownership or contents:
   STOP. Do not silently take ownership, recursively reset ACLs, merge files, or
   remove an untrusted directory. Remediation requires its own reviewed approval.
4. For absent roots, create with the intended security descriptor at creation time,
   not create permissively and harden later. Treat already-exists as failure; do not
   open-and-reuse after a competing creator wins. Keep verified handles and recheck
   identities and security before copying. Never change shared ancestor ACLs.
5. Evaluate DELETE on each object and FILE_DELETE_CHILD on its parent independently.
   Either can permit deletion/replacement; denying DELETE on a leaf is insufficient
   if its parent permits child deletion. Also reject untrusted ownership, WriteDac,
   WriteOwner and write/create rights that can introduce privileged instructions.
6. Parent child-creation permission alone is not arbitrary replacement permission.
   ProgramData may remain unchanged if the new root is securely created, not owned
   by the attacker, and neither root DELETE nor parent DELETE_CHILD is available to
   untrusted tokens. Positively verify this; never infer it from a directory listing.
7. Exclude inherited Creator Owner permissions at application boundaries. Copy file
   data into newly secured destination objects, not source ownership/DACL/SACL.
8. Promote only a new release ID from independently pinned, reviewed hashes. Use
   verified source handles and destination identities; reject file replacement,
   extra files, changed hashes and changed security before acceptance. Do not load
   executable code from staging, repository, Downloads or mutable resource roots.

Check-then-Copy-Item by path alone is not a qualified installer. Protected ancestors,
handle-based identity checks and final revalidation reduce TOCTOU exposure; this
document does not claim elimination. A native safe-promotion implementation remains
unqualified. If stable identity/replacement protection cannot be established, stop.

## 5. Lifecycle mutex compatibility

The recovered [lock implementation](../scripts/chatbot-lifecycle-lock.ps1) uses
`Global\Chatbot.LlamaLifecycle`. Its exact protected mutex DACL grants FullControl
to SYSTEM and `S-1-5-21-1162025873-2456272895-3354061701-1001` only. It verifies the
existing object's DACL, reports busy/abandoned/error states and releases/disposes
owned handles. Preserve all caller fail-closed handling and the same mutex identity.

That SID is installation-specific, not a portable operator role. Another machine
must not blindly retain it or derive a replacement from the current caller. A future
reviewed provisioning change must bind an approved SID consistently across all
callers. This installation must verify the existing SID/account mapping. Do not
change the mutex ACL or create a second mutex during migration. Mutex privileges
do not confer protected-file modification or task-management authorization.

## 6. API-key migration (future explicit approval only)

First obtain elevated source ACL/owner evidence; the prior access denial is not a
confidentiality proof. Confirm source identity, no link/reparse substitution and
the exact Node/SYSTEM consumers. Do not rotate the key as a side effect of moving it.

Create the destination secrets directory securely before handling the key. Read the
source through a verified handle in the approved privileged migration process and
write bytes directly to a newly created, confidential destination file. Preserve the
key bytes, not source ACLs/ownership; never use an intermediate plaintext temp file,
clipboard, command-line value, transcript, console output, Git or general backup.
Verify equality in memory and report only success/failure, never content or a key
hash. Minimize plaintext lifetime; do not promise complete managed-memory erasure.

Test SYSTEM read access and any explicitly approved Node read access without logging
contents. Update exact apiKeyFile references only during approved cutover; maintain
ownership-verifier agreement. Keep the original key unchanged until rollback and
consumer continuity are approved. Do not delete it automatically. Any rollback key
copy must have the same confidentiality; never restore unsafe ACLs from a checkpoint.

## 7. Post-install qualification procedure

Administrator executes only after separately approved staging/maintenance:

1. Capture release pins, exact paths, volume/file IDs, owners, SDDL, inherited ACEs,
   task/reference checkpoint and UTC time in protected evidence. Never record keys.
2. Enumerate every ancestor, release file, DLL, config, secret and runtime resource.
   Match the approved ACL profile including optional grants; reject extras. Check
   reparse points, hard links, parent replacement rights and hash inventory again.
3. Evaluate access using supported native access-check mechanisms and actual tokens:
   unrelated standard user; non-elevated operator; actual Node account; applicable
   Codex identity. Include group/deny/restricted-token behavior. Current-token success
   cannot prove every other identity is denied. Unknown principals block acceptance.
4. Perform authorized non-destructive access probes: request write/delete/ACL-change
   handles without performing those operations; use dedicated disposable canaries
   with the same ACLs for actual create/rename/delete tests. Never overwrite a release,
   remove a real marker or disclose a secret. Unexpected successful forbidden access
   is FAIL, not a reason to continue. Record exact requested access masks and token.
5. Under an actual SYSTEM token, read approved code/config/model and the key (boolean
   result only), and create/write/read/delete uniquely named canaries in logs/state/
   evidence. Do not use watchdog-recovery.pending as a test name. Verify cleanup.
   Run only a separately reviewed diagnostic, never watchdog recovery or llama.cpp.
6. Under unauthorized tokens, key read-open must fail; authorized Node read succeeds
   only if approved. Verify lack of plaintext copies/log output and destination ACL.
7. Rehash immutable release files after probes, recheck identities/ACLs and record
   no changes. Requalify rollback release, runtime and confidential references with
   the same policy. This does not authorize backend stop/start or task activation.

## 8. Fail-closed acceptance matrix

PASS requires recorded positive evidence. FAIL or UNVERIFIED blocks promotion and
activation; do not convert missing access/evidence into assumed safety.

| Gate | PASS evidence | FAIL / UNVERIFIED stop condition |
|---|---|---|
| Trusted roots | Approved owner, exact DACL and stable file identity | Unknown pre-existing root, race, unexpected owner or unreadable descriptor |
| Inheritance | Only approved inheritable ACEs reach children | Creator Owner/broad rights leak or unreviewed explicit ACE |
| Replacement protection | Untrusted tokens lack DELETE, parent DELETE_CHILD, WriteDac/WriteOwner and ownership control | Any replacement/ACL-control path or incomplete token coverage |
| Path integrity | No reparse points; approved file identities and link counts | Redirect, unexpected hard link or unstable observation |
| Release integrity | Seven approved scripts, manifest and complete reviewed runtime closure match independent pins | Missing/extra/mismatched code, writable dependency/search path |
| Non-admin denial | Representative token checks/probes deny all forbidden operations | Any successful forbidden access or token unavailable |
| SYSTEM resources | Actual SYSTEM read and canary read/write/delete succeed as required | ACL-only inference, access denial, unknown environment or failed cleanup |
| Secret confidentiality | Exact approved readers only; migration equality and no disclosure | Broad read, unsafe inherited ACL, plaintext residue or unverifiable source |
| Node compatibility | Required approved reads succeed; all writes denied | Same-account exposure unaccepted, direct protected config writes required |
| Mutex continuity | Existing name/SIDs/security and caller policy agree | Unknown SID mapping, busy/abandoned/error or proposed alternate lock |
| Recovery state | Single authoritative marker location and reviewed handover | Missing evidence, inconsistent locations or proposed reset to force recovery |
| Rollback security | Protected previous release and references independently requalified | Only writable legacy rollback available or uncertain process ownership |
| Activation boundary | Separate task/ownership/SYSTEM/runtime and maintenance approvals | Filesystem acceptance alone offered as authority to activate |

Rollback must preserve security: no copying permissive ACLs back, no restoring a
writable SYSTEM execution chain, no marker reset and no process adoption by PID or
port. If no qualified rollback exists, stop with automation paused under the approved
maintenance procedure. Never assume the old backend may be restarted safely.

## 9. Unresolved decisions and readiness

* Native installer, effective-access collector and safe promotion transaction are
  not implemented/qualified by this document; the offline validator stays blocked.
* Confirm actual operator/Node SIDs and optional exact-file read grants. Account-level
  secrets access also trusts other processes running under that account.
* Qualify inaccessible existing key security, native SYSTEM environment/DLL loading,
  runtime dependency completeness, model access and task action/security descriptors.
* Define approved config-promotion and evidence-consumption interfaces; no direct
  non-elevated writes or snapshot integration are authorized here.
* Existing production scripts remain writable; this design does not remediate them.
* Retained release/backup security, maintenance state handover and rollback target
  need administrator approval. No current directory or deployment is certified safe.

Design review may proceed. Protected deployment and activation remain BLOCKED until
every applicable acceptance gate passes with native evidence and explicit approval.
