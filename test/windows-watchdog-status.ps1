$ErrorActionPreference='Stop'
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\core\windows-watchdog-status.ps1'))
$root=Join-Path ([IO.Path]::GetTempPath()) ('watchdog-status-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
try {
    $log=Join-Path $root 'watchdog.log'; $marker=Join-Path $root 'watchdog-recovery.pending'
    [IO.File]::WriteAllText($log, "not-json`n" + '{"State":"healthy","Reason":"health-healthy","RecoveryAttempted":false,"Secret":"synthetic-private"}' + "`n" + '{"State":"healthy","Reason":"synthetic-private","RecoveryAttempted":false}')
    $import=". (Join-Path `$PSScriptRoot '..\scripts\Test-ChatbotLiveBackendOwnership.ps1')"
    if(-not $source.Contains($import)){throw 'Fixture needs review'}
    $source=$source.Replace($import,'# Injected backend observation; no production import.')
    $source=$source.Replace('C:\AI\logs\watchdog.log',$log).Replace('C:\AI\logs\watchdog-recovery.pending',$marker)
    if($source -match 'C:\\AI\\'){throw 'Unisolated production path'}
    function Get-ScheduledTask { [pscustomobject]@{State='Disabled';Settings=[pscustomobject]@{Enabled=$false}} }
    function Get-ScheduledTaskInfo { [pscustomobject]@{LastRunTime=[datetime]'2026-11-12';NextRunTime=[datetime]::MinValue;LastTaskResult=0} }
    function Test-ChatbotLiveBackendOwnership { [pscustomobject]@{OwnershipVerified=$true;ConfigurationMatched=$true;BackendPid=100} }
    $json=& ([scriptblock]::Create($source)); $result=$json | ConvertFrom-Json
    if($result.task.state -ne 'Disabled' -or $result.task.lastResult -ne 0 -or $result.backend.pid -ne 100 -or $result.marker -ne 'absent'){throw 'Metadata mismatch'}
    if(@($result.log.observations).Count -ne 1 -or -not $result.log.malformed -or $json -match 'synthetic-private|Secret'){throw 'Log sanitization failed'}
    [IO.File]::WriteAllText($marker,'fixture')
    function Get-ScheduledTask { throw 'synthetic-private' }
    $json=& ([scriptblock]::Create($source)); $result=$json | ConvertFrom-Json
    if($null -ne $result.task -or $result.marker -ne 'present' -or $json -match 'synthetic-private'){throw 'Unavailable state failed'}
    Write-Output 'PASS: isolated Windows collector metadata, log sanitization, marker and denied-task checks.'
} finally {
    foreach($name in @('watchdog.log','watchdog-recovery.pending')) { $file=Join-Path $root $name; if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file} }
    [IO.Directory]::Delete($root,$false)
}
