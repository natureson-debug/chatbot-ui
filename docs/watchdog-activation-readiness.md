# MP-GPU-02G — activation plan, not authorization

Production was not executed or changed. User-supplied SYSTEM observation
qualification passed; this task does not repeat it. The inspected production
wrapper calls the absolute repository candidate and then `exit $LASTEXITCODE`.
The candidate dot-sources its two shared helpers using `$PSScriptRoot`; all three
files exist. No dependency on the wrapper's current directory is introduced.

## Exit-code finding

Isolated Windows PowerShell subprocesses confirm the current two-line wrapper
passes explicit 0/1 exits, but a missing candidate incorrectly returns 0. The
minimal replacement is `scripts/watchdog-production-wrapper.ps1`: initialize
LASTEXITCODE to 1, use terminating errors and a catch, and return 0 only after an
explicit successful candidate exit. Missing scripts, throws, failure exits and
normal return without an explicit success exit fail closed. No raw errors are
printed. The replacement has NOT been copied to production.

The healthy policy path launches nothing and maps to exit 0. This is validated
with the actual policy and injected observations plus the candidate's isolated
entry-point branch; it is not a live production watchdog run.

## Phase A — separately approved maintenance preparation

Use elevated Windows PowerShell 5.1. Keep watchdog disabled; do not touch the
running backend, backend task, launcher, credentials or recovery marker.

```powershell
$ErrorActionPreference='Stop'
$name='AI Chatbot - Watchdog'
$wrapper='C:\AI\scripts\chatbot-watchdog.ps1'
$candidate='C:\AI\chatbot-ui\scripts\chatbot-watchdog.ps1'
$replacement='C:\AI\chatbot-ui\scripts\watchdog-production-wrapper.ps1'
$marker='C:\AI\logs\watchdog-recovery.pending'
$task=Get-ScheduledTask -TaskName $name -TaskPath '\'
if($task.Settings.Enabled -or $task.State -in @('Running','Queued')) { throw 'Watchdog must be disabled and idle' }
if(Test-Path -LiteralPath $marker) { throw 'Recovery marker requires investigation; do not delete' }
if($task.Principal.UserId -notin @('SYSTEM','NT AUTHORITY\SYSTEM','S-1-5-18') -or
   $task.Settings.ExecutionTimeLimit -ne 'PT10M' -or
   $task.Settings.MultipleInstances -notin @('IgnoreNew',2) -or
   @($task.Actions).Count -ne 1 -or
   $task.Actions[0].Execute -notin @('powershell.exe','C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe') -or
   $task.Actions[0].Arguments -cne '-NoProfile -ExecutionPolicy Bypass -File "C:\AI\scripts\chatbot-watchdog.ps1"') { throw 'Unexpected task definition' }
if(@($task.Triggers).Count -ne 1 -or $task.Triggers[0].Repetition.Interval -ne 'PT2M') { throw 'Unexpected trigger' }
if($task.Settings.RestartCount -ne 3 -or $task.Settings.RestartInterval -ne 'PT1M') { throw 'Retry settings differ; review before proceeding' }
$checkpoint=Join-Path $env:LOCALAPPDATA ('Renitech\WatchdogCheckpoints\'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($checkpoint)
$beforeXml=Export-ScheduledTask -TaskName $name -TaskPath '\'
[IO.File]::WriteAllText((Join-Path $checkpoint 'task-before.xml'),$beforeXml)
Copy-Item -LiteralPath $wrapper -Destination (Join-Path $checkpoint 'wrapper-before.ps1')
Get-FileHash -LiteralPath $wrapper,$candidate,$replacement
```

Review the full exported task (including any additional settings) and the new
wrapper. Retain the checkpoint path. Reconfirm script/helper hashes match the
reviewed commit and SYSTEM access remains qualified. Check the backend with the
read-only observation command below; stop if not healthy. No inference request
or benchmark is necessary.

## Phase B — approved wrapper and retry-only change, still disabled

Do not construct a new settings object with defaults: it can reset unrelated
settings. Modify only RestartCount on the existing settings instance. This uses
the documented [ScheduledTasks settings interface](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset).

```powershell
$fresh=Get-ScheduledTask -TaskName $name -TaskPath '\'
if($fresh.Settings.Enabled -or $fresh.State -in @('Running','Queued') -or
   (Export-ScheduledTask -TaskName $name -TaskPath '\') -cne $beforeXml) { throw 'Task changed during preparation' }
$settings=$fresh.Settings
$settings.RestartCount=0
Set-ScheduledTask -TaskName $name -TaskPath '\' -Settings $settings | Out-Null
$afterXml=Export-ScheduledTask -TaskName $name -TaskPath '\'
# Compare every serialized task property except the requested Count change.
function WithoutRestartCount([string]$Xml) {
    $doc=New-Object Xml.XmlDocument
    $doc.LoadXml($Xml)
    $ns=New-Object Xml.XmlNamespaceManager($doc.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $node=$doc.SelectSingleNode('/t:Task/t:Settings/t:RestartOnFailure/t:Count',$ns)
    if($null -eq $node) { throw 'Scheduler serialization changed; manual review required' }
    $node.InnerText='0'
    return $doc.OuterXml
}
if((WithoutRestartCount $beforeXml) -cne (WithoutRestartCount $afterXml)) { throw 'Other task properties changed; keep disabled and review' }
$verified=Get-ScheduledTask -TaskName $name -TaskPath '\'
if($verified.Settings.RestartCount -ne 0 -or $verified.Settings.Enabled -or $verified.State -in @('Running','Queued')) { throw 'Retry-only update not verified' }
Copy-Item -LiteralPath $replacement -Destination $wrapper -Force
if((Get-FileHash -LiteralPath $wrapper).Hash -cne (Get-FileHash -LiteralPath $replacement).Hash) { throw 'Wrapper deployment mismatch' }
```

If Windows normalizes/removes RestartOnFailure when count becomes zero, the strict
XML comparison intentionally stops. Review the actual XML difference while still
disabled; do not bypass it or silently accept changes to interval, action,
principal, trigger, execution limit or any other property. The scheduler update
has not been tested against production in this task.

## Phase C — separate activation approval

First perform this read-only observation (no recovery entry point):

```powershell
. 'C:\AI\chatbot-ui\scripts\chatbot-watchdog.ps1'
$observation=Get-ChatbotWatchdogObservation
$observation
if($observation.State -ne 'healthy') { throw 'Activation preflight not healthy' }
```

Before enabling, repeat the SYSTEM observation qualification if candidate/helper
code or account permissions changed since the accepted test. Confirm marker
absent, no queued/running watchdog, no concurrent lifecycle maintenance, correct
reviewed wrapper, RestartCount 0 and all preserved settings. Only then, after
explicit approval, enable and request one run:

```powershell
Enable-ScheduledTask -TaskName $name -TaskPath '\' | Out-Null
Start-ScheduledTask -TaskName $name -TaskPath '\'
Get-ScheduledTask -TaskName $name -TaskPath '\' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName $name -TaskPath '\' | Select-Object LastRunTime,LastTaskResult
Get-Content -LiteralPath 'C:\AI\logs\watchdog.log' -Tail 10
Test-Path -LiteralPath $marker
```

Wait for completion before interpreting LastTaskResult. Acceptance requires a
new run timestamp, exit 0, new `healthy / health-healthy` log record with
`RecoveryAttempted:false`, unchanged backend PID/creation identity, and marker
still absent. Observe at least two scheduled intervals with those same results.
Read existing logs only; never print authorization headers. Do not intentionally
stop the backend to test recovery during this activation.

## Rollback / stop conditions

If evidence changes, recovery unexpectedly occurs, marker appears, logs fail, or
the task fails, disable **only** the watchdog task to prevent further triggers.
Do not stop a running diagnostic/watchdog or backend. Wait for the watchdog run
to finish; investigate a timeout rather than killing processes. Preserve marker
and logs. Once disabled and idle, restore the checkpoint wrapper if appropriate;
restore the old RestartCount only on explicit rollback approval, keeping the task
disabled. Change only that settings property and verify the exported task again.
Never automatically re-enable the old wrapper or reset a recovery marker.

```powershell
Disable-ScheduledTask -TaskName $name -TaskPath '\' | Out-Null
$rollbackTask=Get-ScheduledTask -TaskName $name -TaskPath '\'
if($rollbackTask.State -in @('Running','Queued')) { throw 'Wait for current run; no forced stop authorized' }
Copy-Item -LiteralPath (Join-Path $checkpoint 'wrapper-before.ps1') -Destination $wrapper -Force
# Optional, separately approved restoration of the original retry count:
# $restore=$rollbackTask.Settings; $restore.RestartCount=3
# Set-ScheduledTask -TaskName $name -TaskPath '\' -Settings $restore | Out-Null
```

Limits remain: SYSTEM qualification is supplied evidence, current live recovery
is untested, Windows API calls are not hard-cancelled by the application deadline,
and the no-duplicate policy assumes cooperating launchers use the lifecycle lock.
The candidate never terminates a backend. Enabling is a separate production
decision, not implied by passing these isolated checks.
