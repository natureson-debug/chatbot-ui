# Reviewed replacement for C:\AI\scripts\chatbot-watchdog.ps1.
# Do not execute or deploy without separate activation approval.
$ErrorActionPreference = 'Stop'
$LASTEXITCODE = 1
try {
    & 'C:\AI\chatbot-ui\scripts\chatbot-watchdog.ps1'
    if ($LASTEXITCODE -eq 0) { exit 0 }
    exit 1
} catch {
    # Do not print raw invocation errors or internal paths.
    exit 1
}
