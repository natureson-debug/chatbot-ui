# Managed foreground Node startup (inactive)

This is a dedicated operator-console procedure, not a service or recovery supervisor.
It never adopts/stops existing processes, changes tasks, or starts llama.cpp.

## Resolve active database first

Process Explorer is installed at
`C:\Users\Admin\Downloads\ProcessExplorer\procexp64.exe`.
Desktop automation could not connect to its native helper. Manually reverify Node
PID 21436 and creation time. Select View > Lower Pane View > Handles and record
the full SQLite database/WAL/SHM paths for that process. Never close handles.
Absence of WAL/SHM alone proves nothing. Review Properties > Image for cwd and
command line; review relevant environment settings privately, never export secrets.
Use authorized read-only elevation if needed, not permission changes.

CHATBOT_DB_PATH is optional in the application: absent means data/chatbot.db
relative to loaded db.js; relative overrides use process cwd. CHATBOT_HOME does
not select SQLite. This script requires an explicit verified absolute DB path.

## Maintenance handover

1. Establish the handle path, original console, production account and environment.
   Preserve CHATBOT_HOME, provider credential references/values and feature gates
   securely. The new console inherits its own environment, not the old process's.
2. Create a supported SQLite online backup of the verified database, run
   PRAGMA integrity_check, and create a separate disposable rehearsal copy.
   Do not copy a live main file without WAL or import db.js against live data.
3. Run the schema initializer only on the copy. Compare complete sorted records
   of all existing tables, including users, sessions, chats, messages and system
   logs; verify benchmark tables/indexes and integrity. Preserve the original backup.
4. Snapshot exact reviewed source (including uncommitted work) and startup settings.
   Verify previous-code compatibility with the additive schema on the copy.
5. Pause users. Ctrl+C once in the verified original Node console only. Require
   completed application-shutdown/databaseClosed, process exit and port release.
   If ownership or shutdown is uncertain, stop for a separately approved migration;
   no PID/name termination or adoption is provided.
6. In a dedicated non-elevated PowerShell console under the verified production
   account with the reviewed environment, run the following only after approval:

```powershell
& 'C:\AI\chatbot-ui\scripts\Start-ManagedChatbotNode.ps1' `
  -DatabasePath '<VERIFIED ABSOLUTE SQLITE PATH>' `
  -EnvironmentVerified -MigrationBackupVerified
```

Use -PreflightOnly for checks without loading server.js; port 3000 must still be
free. Switches attest operator verification, not automatic proof. No DB default is
guessed. Node and server paths are absolute; cwd is C:\AI\chatbot-ui and port is
3000. Other environment values are inherited unchanged and never dumped.
The standalone read-only schema/quick_check helper does not migrate or initialize.
Actual application startup still runs migrations, hence the backup/rehearsal gate.

Port checks are snapshots, not a lifetime mutex. Socket binding prevents two
listeners, but competing startup could initialize before bind failure. Exclude
other starts during maintenance. Keep this console/session open; logout/reboot,
window closure or crash can interrupt service. No automatic restart exists.

## Owned stop, validation and rollback

Stop only with Ctrl+C in this dedicated console. Existing SIGINT handling drains
requests and closes SQLite. Require successful shutdown and released listener;
do not close the console or use force termination. This exact foreground wrapper's
graceful shutdown remains a controlled activation acceptance check.

Verify identity/account, loopback port 3000, health, existing authentication and
benchmark admin/non-admin authorization. Do not run benchmarks.
On failure, gracefully stop only the new console's Node, restore the exact source
snapshot and environment, then start through the same procedure. Never automatically
overwrite newer production data with the backup; DB restoration needs separate review.

Current status: not activated. Active DB and original console remain unverified;
online backup, migration rehearsal and real shutdown/start acceptance are pending.
