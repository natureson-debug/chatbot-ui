# Inactive until explicitly invoked in a dedicated non-elevated operator console.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DatabasePath,
    [switch]$EnvironmentVerified,
    [switch]$MigrationBackupVerified,
    [switch]$PreflightOnly
)
$ErrorActionPreference = 'Stop'
$project = 'C:\AI\chatbot-ui'
$node = 'C:\Program Files\nodejs\node.exe'
$entry = Join-Path $project 'server.js'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use the verified non-elevated production account.' }
if (-not [IO.Path]::IsPathRooted($DatabasePath) -or $DatabasePath -notmatch '^(?:[A-Za-z]:\\|\\\\)') { throw 'Supply the verified absolute database path; no default is allowed.' }
foreach ($file in @($node,$entry,$DatabasePath)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'A required executable, entry point or existing database is absent.' } }
if (-not $EnvironmentVerified) { throw 'Verify this console has the production account and environment first; pass -EnvironmentVerified only after review.' }
if ($env:CHATBOT_PORT -and $env:CHATBOT_PORT -ne '3000') { throw 'Conflicting CHATBOT_PORT; refusing to alter production configuration.' }
function Assert-PortFree {
    # .NET enumeration avoids treating CIM access denial as absence.
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (@($listeners | Where-Object { $_.Port -eq 3000 }).Count -gt 0) { throw 'Port 3000 is occupied; no process was stopped or adopted.' }
}
Assert-PortFree
$oldDb = $env:CHATBOT_DB_PATH
$oldPort = $env:CHATBOT_PORT
$oldLocation = Get-Location
try {
    Set-Location -LiteralPath $project
    $env:CHATBOT_DB_PATH = [IO.Path]::GetFullPath($DatabasePath)
    $env:CHATBOT_PORT = '3000'
    & $node (Join-Path $project 'scripts\check-managed-node-db.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Read-only database validation failed.' }
    if ($PreflightOnly) { Write-Output 'Preflight passed. Server not launched.'; return }
    if (-not $MigrationBackupVerified) { throw 'Activation requires verified backup and migration rehearsal; no server launched.' }
    Assert-PortFree
    Write-Output 'Starting foreground Node in this console. Stop only here with Ctrl+C; wait for completed application-shutdown and port release.'
    # Direct foreground invocation: no shell child, detach, PID adoption, retry or kill.
    & $node $entry
    if ($LASTEXITCODE -ne 0) { throw 'Node exited unsuccessfully; inspect console diagnostics. No automatic retry.' }
} finally {
    $env:CHATBOT_DB_PATH = $oldDb
    $env:CHATBOT_PORT = $oldPort
    Set-Location -LiteralPath $oldLocation.Path
}
