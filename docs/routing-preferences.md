# MP-08D.2 routing preferences (inactive)

Authenticated GET/POST `/api/routing-preferences` reads/writes only the session user.
POST uses same-origin intent checks, a 64 KiB body limit, session revalidation and
the currently approved Chat catalog, including existing cloud feature switches.
No client user ID or paid authorization flag is accepted. Preferences never grant
provider access or bypass the decision engine's server-controlled cost policy.

Schema version 1:
```
{ "version": 1, "enabled": false,
  "priorities": { "text": [], "vision": [], "documents": [], "coding": [], "tools": [] },
  "postTask": "return-default", "fallback": "ask" }
```
Each priority item is `{providerId, model}`; at most 20 unique pairs per category.
Post-task values: `return-default`, `keep-specialized`, `ask`.
Fallback values: `next-eligible`, `ask`, `never`.
Missing preferences default to disabled. Removed/unavailable models are excluded
on read, without rewriting stored settings; invalid new selections are rejected.

Existing settings have no generic extensible JSON field. The startup transaction
adds nullable `user_settings.routing_preferences TEXT` after legacy theme migration.
No other table changes are introduced. Existing preferences are untouched; old
settings writers omit and preserve the added column. Rollback leaves the column
in place; do not drop it or restore an old database over newer user data. Migration
rollback is tested on disposable SQLite fixtures. Production was not migrated.

The Settings drawer contains an ordered per-task editor using registered identities,
theme controls and shared notifications. Cached capability eligibility is advisory,
not an access/health guarantee. Missing or expired metadata reads unknown. Documents
explicitly show that extraction routing is not connected. No metadata polling occurs.

The schema reuses `model-router.TASKS`; normalized priorities are compatible with
`decide`. POST and GET always return `active:false`, even when the stored future
opt-in is enabled. No inference code reads these preferences; manual selection is
unchanged. MP-08D.3 must implement policy consent, execution-time authorization,
availability checks and post-task behavior before activating routing.

Desktop/mobile native browser acceptance remains unverified in this environment;
focused source/endpoint tests are not a substitute for authenticated browser checks.
