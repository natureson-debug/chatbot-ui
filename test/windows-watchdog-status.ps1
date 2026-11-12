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
    $script:taskMode='ok'; $script:backendMode='ok'; $script:listenerMode='single'
    function Get-ScheduledTask {
        if($script:taskMode -eq 'hidden') { Write-Error 'synthetic-private' -ErrorId 'CmdletizationQuery_NotFound' -Category ObjectNotFound -ErrorAction Stop }
        if($script:taskMode -eq 'task-denied') { Write-Error 'synthetic-private' -ErrorId 'HRESULT 0x80070005' -Category PermissionDenied -ErrorAction Stop }
        [pscustomobject]@{State='Disabled';Settings=[pscustomobject]@{Enabled=$false}}
    }
    function Get-ScheduledTaskInfo {
        if($script:taskMode -eq 'denied') { Write-Error 'synthetic-private' -ErrorId 'HRESULT 0x80070005' -Category PermissionDenied -ErrorAction Stop }
        if($script:taskMode -eq 'missing') { Write-Error 'synthetic-private' -ErrorId 'HRESULT 0x80070002' -Category ObjectNotFound -ErrorAction Stop }
        [pscustomobject]@{LastRunTime=[datetime]'2026-11-12';NextRunTime=[datetime]::MinValue;LastTaskResult=0}
    }
    function Test-ChatbotLiveBackendOwnership {
        switch($script:backendMode) {
            'ok' { [pscustomobject]@{OwnershipVerified=$true;ConfigurationMatched=$true;BackendPid=100;Reason='verified'} }
            'mismatch' { [pscustomobject]@{OwnershipVerified=$true;ConfigurationMatched=$false;BackendPid=100;Reason='configuration-mismatch'} }
            'unavailable' { [pscustomobject]@{OwnershipVerified=$false;ConfigurationMatched=$false;BackendPid=$null;Reason='evidence-unavailable'} }
            'unsafe' { [pscustomobject]@{OwnershipVerified=$false;ConfigurationMatched=$false;BackendPid=100;Reason='configuration-mismatch'} }
            'invalid-type' { [pscustomobject]@{OwnershipVerified=$true;ConfigurationMatched='false';BackendPid=100;Reason='configuration-mismatch'} }
            'changed' { [pscustomobject]@{OwnershipVerified=$false;ConfigurationMatched=$false;BackendPid=$null;Reason='configuration-changed'} }
            'error' { throw 'synthetic-private' }
        }
    }
    function Get-NetTCPConnection {
        if($script:listenerMode -eq 'denied') { throw 'synthetic-private' }
        [pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=8080;OwningProcess=100}
        if($script:listenerMode -eq 'multiple') { [pscustomobject]@{LocalAddress='0.0.0.0';LocalPort=8080;OwningProcess=101} }
    }
    $json=& ([scriptblock]::Create($source)); $result=$json | ConvertFrom-Json
    if($result.task.state -ne 'Disabled' -or $result.task.lastResult -ne 0 -or $result.backend.pid -ne 100 -or $result.marker -ne 'absent'){throw 'Metadata mismatch'}
    if(@($result.log.observations).Count -ne 1 -or -not $result.log.malformed -or $json -match 'synthetic-private|Secret'){throw 'Log sanitization failed'}
    [IO.File]::WriteAllText($marker,'fixture')
    foreach($case in @(@('denied','task-access-denied'),@('task-denied','task-access-denied'),@('missing','task-not-found'),@('hidden','task-unavailable'))) {
        $script:taskMode=$case[0]
        $json=& ([scriptblock]::Create($source)); $result=$json | ConvertFrom-Json
        if($null -ne $result.task -or $result.taskReason -ne $case[1] -or $result.marker -ne 'present' -or $json -match 'synthetic-private'){throw "Task scenario $($case[0]) failed"}
    }
    $script:taskMode='ok'
    foreach($case in @('unavailable','unsafe','invalid-type','error')) {
        $script:backendMode=$case
        $json=& ([scriptblock]::Create($source)); $result=$json | ConvertFrom-Json
        if($null -ne $result.backend.verified -or $null -ne $result.backend.configurationMatched -or $null -ne $result.backend.pid -or
           $result.backend.reason -ne 'evidence-unavailable' -or $result.observedListenerPid -ne 100 -or $json -match 'synthetic-private'){throw "Backend scenario $case failed"}
    }
    $script:backendMode='changed'
    $result=(& ([scriptblock]::Create($source))) | ConvertFrom-Json
    if($result.backend.reason -ne 'configuration-changed' -or $null -ne $result.backend.configurationMatched){throw 'Changed configuration scenario failed'}
    $script:backendMode='mismatch'
    $result=(& ([scriptblock]::Create($source))) | ConvertFrom-Json
    if($result.backend.verified -ne $true -or $result.backend.configurationMatched -ne $false -or
       $result.backend.reason -ne 'configuration-mismatch' -or $result.backend.pid -ne 100 -or $null -ne $result.observedListenerPid){throw 'Verified mismatch failed'}
    $script:backendMode='unavailable'
    foreach($script:listenerMode in @('multiple','denied')) {
        $result=(& ([scriptblock]::Create($source))) | ConvertFrom-Json
        if($null -ne $result.observedListenerPid){throw "Listener scenario $script:listenerMode failed"}
    }
    Write-Output 'PASS: isolated collector task errors, unavailable evidence, verified mismatch, listener and log sanitization.'
} finally {
    foreach($name in @('watchdog.log','watchdog-recovery.pending')) { $file=Join-Path $root $name; if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file} }
    [IO.Directory]::Delete($root,$false)
}
