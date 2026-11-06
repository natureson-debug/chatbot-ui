# MP-07.2B-2B attachment storage

## Windows deployment policy (S4)

Preferred data root: `%LOCALAPPDATA%\Renitech\Chatbot`, provisioned for and
owned/controlled by the intended application account. Unrelated local identities
must have no write, delete, delete-child, WRITE_DAC or WRITE_OWNER authority on
the root or ancestors that could permit replacement. Private attachment directories
and files must also deny unauthorized reading through an appropriately restricted
DACL. Check inherited grants and newly created child ACLs; Node mode bits alone
do not establish a Windows DACL. Administrators and SYSTEM are trusted management
identities, not adversaries covered by this policy.

The current legacy directory is **not qualified**: prior inspection found broad
Authenticated Users Modify grants on its ancestors. Committing this implementation
does not approve deployment there or activate portable mode. A separate deployment
review must verify the intended account, ownership, effective permissions and
reparse-free ancestry, and explicitly approve provisioning or migration. Enabling
per-user mode also changes SQLite selection; never use it as an attachment-only
workaround. No automatic migration, permission repair or policy enforcement is
introduced here. Same-user malicious processes, administrators and SYSTEM remain
outside the protection guarantee. TOCTOU races are not eliminated.

The standalone ACL collector/preflight is diagnostic only and is never invoked by
startup or attachment requests. Its default implementation cannot qualify storage;
injected test proofs are simulations, not Windows qualification. The experimental
native AccessCheck POC is excluded from this implementation's commit.

## Storage behavior

`core/attachments.js` now uses `resolveStoragePaths()` from `core/data-paths.js`.
SQLite and attachments share storage-mode selection through that pure helper.
Legacy Windows and default installation mode retain installation `data/attachments`.
Explicit `CHATBOT_STORAGE_MODE=per-user` selects `dataRoot/data/attachments`.
Root precedence and conflict validation remain unchanged. `CHATBOT_DB_PATH` affects
only SQLite: attachments never follow the directory of an overridden database.

Only a successful upload's write phase creates directories. Resolution, retrieval
and deletion create none. No files are searched for, copied or migrated. Missing
attachments raise `Attachment unavailable`; the existing HTTP route returns its
existing generic operation error without paths or fallback.

Consumers: `core/extension-routes.js` authenticates upload/retrieval/deletion,
revalidates sessions and checks same-origin writes; `server.js` expands attachment
markers before inference. `core/attachments.js` hashes the authenticated user ID
for the owner directory. UUID filenames, JSON records and persisted message markers
`[Chatbot attachment: UUID]` are unchanged. There is no attachment table migration
or new retention/cleanup policy; explicit removal continues to unlink one record.
The document worker remains an installation resource.

Security checks reject filename traversal, invalid IDs, relative roots, file
symlinks and symlink/junction directory components (including root ancestors).
Reads use a retained file handle and compare identity against lstat; O_NOFOLLOW
is used where available. Deletion checks directories again immediately before
unlink. Existing authenticated owner scoping is unchanged.

Limitation: portable Node filesystem APIs do not provide a cross-platform
handle-relative directory traversal/unlink primitive. A hostile local writer
concurrently swapping parent directories can still create a check/use race.
The storage tree and its ancestors must be protected from untrusted local writers;
these checks are not a sandbox against such an attacker. No ACLs are changed here.
Existing installations intentionally using symlinked storage must be reviewed:
they now fail closed. Native macOS temporary-directory symlinks may likewise
require a canonical configured root; automatic path redirection is not performed.

Selecting portable storage does not make legacy attachments available. Migration
of existing message-referenced files requires separate approval and validation.
