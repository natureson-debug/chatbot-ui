# Fixed read-only collector. No browser-controlled arguments and no recovery call.
$ErrorActionPreference='Stop'
$result=[ordered]@{task=$null;taskReason='task-unavailable';backend=$null;observedListenerPid=$null;marker='unavailable';log=$null}
function IsoDate($value) { if($value -is [datetime] -and $value.Year -ge 2000){return $value.ToUniversalTime().ToString('o')}; return $null }
try {
    $info=Get-ScheduledTaskInfo -TaskName 'AI Chatbot - Watchdog' -TaskPath '\' -ErrorAction Stop
    try {
        $task=Get-ScheduledTask -TaskName 'AI Chatbot - Watchdog' -TaskPath '\' -ErrorAction Stop
        $result.task=@{state=[string]$task.State;enabled=[bool]$task.Settings.Enabled;lastRun=(IsoDate $info.LastRunTime);nextRun=(IsoDate $info.NextRunTime);lastResult=[long]$info.LastTaskResult}
        $result.taskReason=$null
    } catch {
        if($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.FullyQualifiedErrorId -match '0x80070005'){$result.taskReason='task-access-denied'}
    }
} catch {
    if($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.FullyQualifiedErrorId -match '0x80070005'){$result.taskReason='task-access-denied'}
    elseif($_.FullyQualifiedErrorId -match '0x80070002'){$result.taskReason='task-not-found'}
}
try {
    . (Join-Path $PSScriptRoot '..\scripts\Test-ChatbotLiveBackendOwnership.ps1')
    $e=Test-ChatbotLiveBackendOwnership
    $result.backend=@{verified=$null;configurationMatched=$null;pid=$null;reason='evidence-unavailable'}
    if($e.OwnershipVerified -is [bool] -and $e.OwnershipVerified -eq $true -and
       $e.ConfigurationMatched -is [bool] -and $e.BackendPid -is [int] -and $e.BackendPid -gt 0 -and
       (($e.Reason -ceq 'verified' -and $e.ConfigurationMatched -eq $true) -or
        ($e.Reason -ceq 'configuration-mismatch' -and $e.ConfigurationMatched -eq $false))) {
        $result.backend=@{verified=$true;configurationMatched=[bool]$e.ConfigurationMatched;pid=$e.BackendPid;reason=$e.Reason}
    } elseif($e.Reason -cin @('ownership-unverified','ownership-changed','configuration-changed','evidence-unavailable')) {
        $result.backend.reason=$e.Reason
    }
} catch {
    $result.backend=@{verified=$null;configurationMatched=$null;pid=$null;reason='evidence-unavailable'}
}
if($null -eq $result.backend -or $result.backend.verified -ne $true) {
    try {
        $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 8080)
        if($listeners.Count -eq 1 -and $listeners[0].LocalAddress -ceq '127.0.0.1' -and $listeners[0].OwningProcess -gt 0) {
            $result.observedListenerPid=[int]$listeners[0].OwningProcess
        }
    } catch {
        $result.observedListenerPid=$null
    }
}
try {
    $exists=Test-Path -LiteralPath 'C:\AI\logs\watchdog-recovery.pending' -ErrorAction Stop
    $result.marker=if($exists){'present'}else{'absent'}
} catch {}
try {
    $file='C:\AI\logs\watchdog.log'
    $item=Get-Item -LiteralPath $file -ErrorAction Stop
    $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try {
        $length=[int][Math]::Min(16384,$stream.Length)
        $truncated=$stream.Length -gt $length
        [void]$stream.Seek(-$length,[IO.SeekOrigin]::End)
        $bytes=New-Object byte[] $length
        $read=$stream.Read($bytes,0,$length)
        $lines=@([Text.Encoding]::UTF8.GetString($bytes,0,$read) -split "`n")
        if($truncated -and $lines.Count -gt 1){$lines=$lines[1..($lines.Count-1)]}
    } finally { $stream.Dispose() }
    $rows=@(); $invalid=0
    $states=@('healthy','starting','unhealthy','absent','uncertain')
    $reasons=@('lock-unavailable','absence-not-stable','recovery-latched','recovery-timeout','recovery-verified','recovery-not-verified','observation-or-recovery-failed','backend-task-disabled','task-starting','verified-absence','task-state-unverified','listener-not-ready','process-or-listener-unverified','ownership-or-configuration-unverified','evidence-changed','evidence-unavailable','health-healthy','health-starting','health-unhealthy','health-uncertain')
    foreach($line in $lines){
        if([string]::IsNullOrWhiteSpace($line)){continue}
        try {
            $o=$line | ConvertFrom-Json -ErrorAction Stop
            if($o.State -cnotin $states -or $o.Reason -cnotin $reasons -or $o.RecoveryAttempted -isnot [bool]){throw 'invalid'}
            $rows+=@{state=$o.State;reason=$o.Reason;recoveryAttempted=$o.RecoveryAttempted}
        } catch {$invalid++}
    }
    $result.log=@{updatedAt=(IsoDate $item.LastWriteTime);observations=@($rows | Select-Object -Last 12);malformed=($invalid -gt 0)}
} catch {}
$result | ConvertTo-Json -Depth 5 -Compress
