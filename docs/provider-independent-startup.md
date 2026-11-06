# Provider-independent startup (MP-07.2A)

Application startup does not initialize the Windows llama.cpp runtime or probe
inference providers. Configured remote providers need no local GGUF, llama.cpp
executable, or llama.cpp API-key file. An unreachable provider fails its request;
it does not select another provider automatically.

Legacy-local discovery is used only when the existing connection registry selects
`legacy-local` (including its existing missing-registry default). An absent local
configuration or models directory makes that optional provider unavailable.
Malformed existing local configuration remains an error.

When no enabled default provider is available, `/api/ai/runtime` reports
`state: configuration_required` and `code: PROVIDER_CONFIGURATION_REQUIRED`.
Chat requests without an available selection receive HTTP 503 with that code.
The model catalog remains empty when no models are available. Administrators can
configure providers using the existing interface.

Database startup policy is unchanged: an existing valid database is required;
missing databases are not silently created. Provider-only installations must use
the existing intentional database initialization procedure and existing path
settings (`CHATBOT_HOME`, and `CHATBOT_DB_PATH` for the database).

Optional legacy administration and GPU/process inspection remain platform-specific.
Windows process inspection is loaded on demand by the legacy status endpoint,
after its backend health check; non-Windows status does not load it. This change
does not qualify lifecycle management on another platform, change activation or
ownership gates, or implement the deferred MP-07.2C controls.

`test/provider-startup.test.js` runs copied application source with disposable
databases, loopback ephemeral listeners and an injected inference adapter. It
rejects eager Windows runtime imports and unexpected outbound HTTP requests.
These tests qualify startup and routing, not real remote inference or native
macOS/Linux deployment.
