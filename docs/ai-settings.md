# Additional AI launch settings

The existing admin GET/POST `/api/admin/ai/config` routes still use the existing
`chatbot-ai-config.json`; SQLite is not involved. Model selection, parallel and
context validation are unchanged. GET adds effective legacy defaults without
writing the file. POST preserves unknown saved properties, ignores unknown incoming
properties, and retains saved optional fields omitted by older clients.

| Property | Accepted values | Missing legacy value |
|---|---|---|
| gpuLayers | JSON integer 0–999 | 37 |
| device | Exact string CUDA0 | CUDA0 |
| verbosity | JSON integer 0–5 | 4 |

The GPU layer upper bound is an application policy for the b11609 runtime, not a
claim about any particular model's layer count, memory fit or actual offloading.
Actual offload remains a runtime observation. Dynamic CUDA device enumeration is
not added: NVIDIA management-tool ordinals are not assumed to be CUDA ordinals.
The supported fallback dropdown contains only the existing CUDA0 identifier.
Verbosity 0–5 corresponds to the documented b11609 thresholds:
https://github.com/ggml-org/llama.cpp/blob/b11609/common/arg.cpp

The optimized target is 45/CUDA0/4 with context 32768 and parallel 1. It must be
selected and saved intentionally. Existing files missing optional fields show
37/CUDA0/4, never silently switch to 45. Explicit nulls, strings for numbers,
fractional values and command-line fragments are rejected.

Validation completes before saving. A unique sibling file is fully written before
rename/replacement; failure leaves the old destination intact and cleans up the
temporary file. This is not a power-loss durability guarantee or a multi-process
revision protocol. Replacement files inherit the config directory permissions;
installations with custom file-only ACLs need deployment review before saving.

The PowerShell launcher validates the same optional values before conversions or
launch side effects and passes them as individual arguments. Existing paths,
networking, API-key checks, logging and lifecycle behavior are unchanged.
No production configuration was written, and no running service was restarted.
The standalone pure explicit launch-spec API remains unchanged; this task extends
the existing Admin JSON / Scheduled Task launcher path only.

Deployment needs an approved Node reload for new API code. Saving does not apply
settings to a running backend. A separately authorized existing backend restart
is required; no automatic restart is introduced.

Validation: `node --test test/*.test.js`; Windows PowerShell
`-NoProfile -ExecutionPolicy Bypass -File test/ai-launcher-settings.ps1`.
The PowerShell test parses the external launcher and runs only its validation and
argument-array fragments with synthetic values. It never executes the launcher.
