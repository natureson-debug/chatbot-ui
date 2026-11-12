$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try {
    if($identity.User.Value -cne 'S-1-5-18'){throw 'Producer identity is not authorized.'}
    $status=& (Join-Path $PSScriptRoot 'windows-watchdog-status.ps1') | ConvertFrom-Json -ErrorAction Stop
    @{identity=$identity.User.Value;status=$status} | ConvertTo-Json -Depth 7 -Compress
} finally {
    $identity.Dispose()
}
