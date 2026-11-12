# Fixed read-only collector. No browser-controlled arguments and no recovery call.
$ErrorActionPreference='Stop'
$result=[ordered]@{task=$null;backend=$null;marker='unavailable';log=$null}
function IsoDate($value) { if($value -is [datetime] -and $value.Year -ge 2000){return $value.ToUniversalTime().ToString('o')}; return $null }
try {
    $task=Get-ScheduledTask -TaskName 'AI Chatbot - Watchdog' -TaskPath '\' -ErrorAction Stop
    $info=Get-ScheduledTaskInfo -TaskName 'AI Chatbot - Watchdog' -TaskPath '\' -ErrorAction Stop
    $result.task=@{state=[string]$task.State;enabled=[bool]$task.Settings.Enabled;lastRun=(IsoDate $info.LastRunTime);nextRun=(IsoDate $info.NextRunTime);lastResult=[long]$info.LastTaskResult}
} catch {}
try {
    . (Join-Path $PSScriptRoot '..\scripts\Test-ChatbotLiveBackendOwnership.ps1')
    $e=Test-ChatbotLiveBackendOwnership
    $result.backend=@{verified=[bool]$e.OwnershipVerified;configurationMatched=[bool]$e.ConfigurationMatched;pid=$e.BackendPid}
} catch {}
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
