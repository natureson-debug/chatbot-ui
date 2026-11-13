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
$checkpoint=Join-Path $env:LOCALAPPDATA ('AIChatbot\WatchdogCheckpoints\'+[guid]::NewGuid().ToString('N'))
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

Do not set RestartCount to zero through the CIM settings object. The observed
HRESULT 0x80041319 left the definition unchanged: a present RestartOnFailure
requires both Interval and Count, with Count at least 1. Remove the **entire**
optional RestartOnFailure element instead. Its Interval is removed with it;
all other settings, triggers, principal and actions must remain identical.
See Microsoft's [RestartOnFailure schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element)
and [Count minimum](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-count-restarttype-element).

MP-GPU-02G.1 validated this on a unique, current-user temporary task using native
Task Scheduler: baseline registration with retries, removal/update, export,
exact preservation of all other XML, retry count zero, and successful harmless
execution. The temporary task was removed. This was not a production or SYSTEM
task update. The production task remains disabled; no wrapper was changed.

The following is a **separately approved production procedure**, not executed
by this task. Continue in the Phase A session with its checkpoint and beforeXml:

```powershell
. 'C:\AI\chatbot-ui\scripts\watchdog-retry-xml.ps1'
$fresh=Get-ScheduledTask -TaskName $name -TaskPath '\'
if($fresh.Settings.Enabled -or $fresh.State -in @('Running','Queued') -or
   (Export-ScheduledTask -TaskName $name -TaskPath '\') -cne $beforeXml) { throw 'Task changed during preparation' }
$proposedXml=Remove-ChatbotTaskRetryPolicy $beforeXml
$service=New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder=$service.GetFolder('\')
$existing=$folder.GetTask($name)
$securityBefore=$existing.GetSecurityDescriptor(7) # Owner, group, DACL; no SACL.
# TASK_UPDATE (4) + TASK_DONT_ADD_PRINCIPAL_ACE (16). No create/enable flags.
# Existing SYSTEM principal and all other XML remain as exported.
$updated=$folder.RegisterTask($name,$proposedXml,20,'SYSTEM',$null,5,$null)
$afterXml=Export-ScheduledTask -TaskName $name -TaskPath '\'
$afterDoc=New-Object Xml.XmlDocument
$afterDoc.LoadXml($afterXml)
if($afterDoc.OuterXml -cne $proposedXml -or $afterXml -match '<RestartOnFailure') { throw 'Unexpected task XML change; keep disabled and review' }
if($updated.GetSecurityDescriptor(7) -cne $securityBefore) { throw 'Unexpected task security change; keep disabled and review' }
$verified=Get-ScheduledTask -TaskName $name -TaskPath '\'
if($verified.Settings.RestartCount -ne 0 -or $verified.Settings.Enabled -or $verified.State -in @('Running','Queued')) { throw 'Retry-policy update not verified' }
Copy-Item -LiteralPath $replacement -Destination $wrapper -Force
if((Get-FileHash -LiteralPath $wrapper).Hash -cne (Get-FileHash -LiteralPath $replacement).Hash) { throw 'Wrapper deployment mismatch' }
```

If the update fails, re-export and compare to the checkpoint; do not assume any
change committed. Any unexpected serialization, security, principal or other
setting difference blocks activation. Do not weaken the comparisons. Removing
RestartOnFailure intentionally removes its now-inapplicable PT1M interval; the
PT2M trigger, PT10M execution timeout, IgnoreNew policy and disabled state stay.

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
restore the original checkpoint XML only on explicit rollback approval, keeping
the task disabled. Verify the current definition has no unrelated changes first.
Never automatically re-enable the old wrapper or reset a recovery marker.

```powershell
Disable-ScheduledTask -TaskName $name -TaskPath '\' | Out-Null
$rollbackTask=Get-ScheduledTask -TaskName $name -TaskPath '\'
if($rollbackTask.State -in @('Running','Queued')) { throw 'Wait for current run; no forced stop authorized' }
Copy-Item -LiteralPath (Join-Path $checkpoint 'wrapper-before.ps1') -Destination $wrapper -Force
# Optional, separately approved restoration from the existing Phase A checkpoint:
# $restoreXml=[IO.File]::ReadAllText((Join-Path $checkpoint 'task-before.xml'))
# $restoreDoc=New-Object Xml.XmlDocument; $restoreDoc.LoadXml($restoreXml)
# if($restoreDoc.Task.Settings.Enabled -ne 'false') { throw 'Checkpoint must be disabled' }
# $currentXml=Export-ScheduledTask -TaskName $name -TaskPath '\'
# $currentDoc=New-Object Xml.XmlDocument; $currentDoc.LoadXml($currentXml)
# if($currentDoc.OuterXml -cne (Remove-ChatbotTaskRetryPolicy $restoreXml)) { throw 'Unrelated changes: rollback needs review' }
# $restored=$folder.RegisterTask($name,$restoreXml,20,'SYSTEM',$null,5,$null)
# $check=New-Object Xml.XmlDocument; $check.LoadXml((Export-ScheduledTask -TaskName $name -TaskPath '\'))
# if($check.OuterXml -cne $restoreDoc.OuterXml -or $restored.GetSecurityDescriptor(7) -cne $securityBefore) { throw 'Rollback not verified; keep disabled' }
```

Limits remain: SYSTEM qualification is supplied evidence, current live recovery
is untested, Windows API calls are not hard-cancelled by the application deadline,
and the no-duplicate policy assumes cooperating launchers use the lifecycle lock.
The candidate never terminates a backend. Enabling is a separate production
decision, not implied by passing these isolated checks.
