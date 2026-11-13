# MP-07.2B-1: portable data-path foundation

Status: MP-07.2B-2A integrates SQLite startup and the intentional first-run CLI.
Other storage consumers remain unchanged. No data relocation is performed.

SQLite startup and `scripts/initialize-database.cjs --create-new-database` use
the same `databasePath()` selection. Unset `CHATBOT_STORAGE_MODE` preserves
installation-relative SQLite: `legacy-windows` on Windows, `installation` on
macOS/Linux. Set `CHATBOT_STORAGE_MODE=per-user` intentionally to select per-user
storage. `installation` is an additional explicit resolver mode with its root
and database under the installation directory. It never falls back to C:\AI.
Root overrides alone do not relocate the legacy/installation database.
Absolute `CHATBOT_DB_PATH` still takes precedence; empty or relative values fail
with `APP_DATA_PATH_INVALID`. Existing relative-path deployments must supply an
absolute path before upgrading; no working-directory conversion is performed.

Missing databases always fail normal startup. First-run creation requires the
explicit CLI flag and a pre-created parent directory; existing files cannot be
overwritten. Set the same environment for initialization and startup. Neither
command searches for, copies, or imports another database. Existing schema
initialization/migration checks and SQLite journal/locking behavior are unchanged.

## API and precedence

`core/data-paths.js` exports `resolveDataPaths({ platform, env, home,
installationRoot, mode })`. All inputs are injected; there is no ambient
environment, filesystem probing, directory creation, database opening or credential
reading. Returned paths are deployment metadata, not browser-facing information.

The resolver caller must explicitly choose `legacy-windows`, `installation`, or `per-user`. Existing Windows
installations must retain legacy mode until a separately approved migration.
There is deliberately no automatic installation detection or default mode.

1. Absolute `CHATBOT_DATA_ROOT` selects the root.
2. Existing absolute `CHATBOT_HOME` is the compatibility alias. If both are set,
   they must normalize to the same path (case-insensitive on Windows).
3. Without an override, legacy Windows uses `C:\AI`. Per-user Windows uses
   `LOCALAPPDATA\AIChatbot`, falling back to the supplied home directory's
   `AppData\Local\AIChatbot` only when LOCALAPPDATA is absent.
4. macOS uses `~/Library/Application Support/AIChatbot`.
5. Linux uses `$XDG_DATA_HOME/aichatbot`, or
   `~/.local/share/aichatbot` when XDG_DATA_HOME is absent.
6. Absolute `CHATBOT_DB_PATH` overrides the database path independently, including
   outside the selected root. It must never be silently ignored.

In legacy mode, database and attachment defaults stay under
`installationRoot/data`, even with a root override: this preserves the existing
split layout. In per-user mode they are under `dataRoot/data`. Other configuration
paths follow `dataRoot/config`. The proposed diagnostics directory is
`dataRoot/logs`; this does not relocate current logs. Runtime temporary files are
not assigned a new path in this stage.

Empty, malformed, relative, drive-relative, foreign-platform and conflicting root
inputs fail with `APP_DATA_PATH_INVALID`. Errors name the configuration field,
never its supplied path. Only relevant platform defaults are consulted. A supplied
invalid override is never replaced by a fallback. Unsupported platforms fail.

## Current storage inventory and future consumers

| Resource | Current source | Classification / integration still needed |
| --- | --- | --- |
| SQLite, users, sessions, history, system events, usage and benchmarks | `db.js`, `core/database-startup.js`, `core/system-logs.js`; `CHATBOT_DB_PATH` or installation `data/chatbot.db` | Persistent application data; retain existing fail-closed opening and intentional initialization |
| Attachments | `core/attachments.js`, installation `data/attachments` | Persistent application data; move only in a separately approved migration |
| Provider configuration | `core/connections.js`, sibling of AI config: `chatbot-connections.json` | Persistent application data |
| Protected credential blobs | `core/protected-credentials.js`, config `protected-credentials/*.dpapi` | Persistent protected data; Windows CurrentUser DPAPI remains account-bound |
| API credential references | Provider/extension JSON; environment references resolved server-side | References are configuration; environment secrets are not files to relocate |
| Skills, search, MCP configuration | `core/extensions.js`, config `chatbot-extensions.json` | Persistent application data; MCP commands/document sources remain external resources |
| llama.cpp config and key | `core/paths.js`: `chatbot-ai-config.json`, `llama-api-key.txt` | Optional external inference integration configuration/secret; never copy or decrypt automatically |
| GGUF models and llama.cpp executable directory | `core/paths.js`: root `models` and `llama.cpp` | External inference-server resources, not mandatory app data |
| Public assets, JS modules and document worker | Installation directory / `__dirname` | Application installation resources; must not resolve into writable data by default |
| Application diagnostics | Console output; managed-startup documentation; deployment-specific launcher captures | Temporary/runtime or operator-managed persistent diagnostics; not consolidated yet |
| Atomic JSON/credential temporary files | Existing writers create sibling temporary files | Temporary/runtime data on the destination filesystem; preserve atomic rename semantics |

## Compatibility and security boundaries

This resolver cannot validate existence, database integrity, ACLs, symlinks,
junctions or ownership. The later integration must use the existing fail-closed
database opener and must not initialize a missing database automatically. No
filesystem existence-based fallback is permitted. Resolving a path never proves
that it is safe to open or write.

Earlier `db.js` permitted relative CHATBOT_DB_PATH; this integration intentionally rejects
relative overrides to avoid working-directory-dependent selection. Audit and
explicitly convert such deployments before integration. Existing Linux `.chatbot`
and macOS `Application Support/Chatbot` defaults differ from the new per-user layout:
they require explicit absolute overrides or a separately approved migration, never
automatic switching. Windows credential portability and remote lifecycle controls
remain outside scope. `docs/mp-07-implementation-plan.md` is unchanged.
