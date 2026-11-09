# Apple Silicon desktop development launch (MP-07.MAC-01)

This is an Electron development shell, not a signed, self-contained installer.
It reuses the existing UI, authenticated HTTP API and provider adapters. No
inference engine or model is bundled. Native macOS acceptance is still required;
Windows fixture results do not establish that the macOS window works.

## Launch on an Apple Silicon Mac

Prerequisites: an arm64 Node.js 24 installation, npm, and this repository including
its existing root dependencies. In the repository directory:

```sh
npm ci
npm ci --prefix desktop
# ONLY for a deliberately new installation; prompts for admin username/password:
node desktop/initialize.cjs --create-new-installation
CHATBOT_DESKTOP_NODE="$(command -v node)" npm start --prefix desktop
```

The password is hidden and uses the existing application password hash. The
initializer refuses to overwrite any existing database. Do not initialize again
to recover a missing database: restore the intended data after review. Failed
initialization may leave a reserved database requiring review; no automatic
delete or retry occurs. Never run the initializer against legacy Windows data.

Data lives at `~/Library/Application Support/Renitech/Chatbot`:
SQLite in `data/chatbot.db`, attachments in `data/attachments`, provider and
extension configuration in `config`. Electron also keeps its session files in
this per-user directory. Nothing is copied from legacy storage. The desktop
child explicitly sets the existing portable resolver and CHATBOT_HOME together;
inherited storage overrides do not redirect it to another installation.

Sign in using the new administrator. Configure an already running Ollama or
llama.cpp provider in Admin → AI Providers, discover/approve its models, then
select one in chat. Providers can be remote; no local engine is required.
Use no credentials or existing `env:` references. Environment credentials must
be present in the shell launching Electron; Finder does not inherit shell
configuration. Existing protected GUI credentials remain Windows-only; no
plaintext replacement or Keychain backend is introduced.

## Ownership and shutdown

Electron holds its single-instance lock for the desktop lifetime. It forks one
Node child with an absolute executable, explicit working directory, private IPC,
and retained ChildProcess object. The bootstrap requests port zero on 127.0.0.1
and reports the assigned address; health must succeed before loading the UI.
No unrelated process is adopted or terminated. The normal server startup is
unchanged except exporting its server reference.

Closing the window or quitting sends a private shutdown message to the child,
using the existing HTTP/database lifecycle. Parent disconnect also requests
graceful shutdown. The parent waits up to 25 seconds for exit; incomplete shutdown
is reported rather than forcing a PID-based kill. This is cooperative cleanup,
not kernel containment against a hung or hostile child. Backend stdout/stderr
are suppressed to avoid surfacing raw provider diagnostics; startup errors are
sanitized, so detailed operational diagnostics are limited in this milestone.

Web content has no Node integration or preload bridge. Context isolation and
sandbox are enabled, permissions and new windows are denied, and navigation is
limited to the owned loopback origin. Existing application authentication stays
in place; TLS/LAN configuration and production services are unchanged. These
settings follow [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security/).

## Validation and remaining acceptance

Disposable Windows tests verify explicit initialization, overwrite refusal,
missing-database failure, actual dynamic-port backend health, authenticated
history persistence across restart and graceful child exit. Existing startup
fixtures verify remote/no-provider/unreachable-provider routing without local
llama.cpp. They are not native Electron or macOS browser tests.

On macOS still verify: Electron launch, single-instance focus, cookie-backed
login on loopback, protected-credential error clarity, model discovery, streamed
Ollama and llama.cpp replies, attachments, history after quit/reopen, and process
exit on window close. No live inference was run during implementation. The
current host cannot satisfy the requested 'macOS application running' milestone.
No production activation or migration is authorized by this implementation.

Rollback: stop this desktop instance normally and remove only the new desktop
shell/test/documentation plus its server export hunk. Preserve per-user data and
all pre-existing work. Do not revert the entire already-modified server.js.
