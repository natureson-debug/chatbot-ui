# Controlled SYSTEM observation — approval required before execution

This procedure qualifies only the read-only observation path. It does not qualify
recovery, modify the production watchdog/task, acquire a lifecycle lock, or touch
`watchdog-recovery.pending`. The production task stays disabled. Its reported
10-minute limit is unchanged. No runtime step below was executed during development.

Use a fresh **elevated Windows PowerShell 5.1** session after explicit approval.
The repository scripts must be the reviewed commit. Staging copies four files to
a unique directory directly below ProgramData, with inheritance disabled and full
access granted only to SYSTEM and built-in Administrators. This relies on normal
Windows protection of ProgramData against deletion/replacement of other owners'
children; if local policy grants broader replacement rights, stop for ACL review.
Administrators/SYSTEM are trusted. No production permission is changed.

## 1. Stage the reviewed diagnostic (no scheduled task yet)

```powershell
$ErrorActionPreference = 'Stop'
$repo = 'C:\AI\chatbot-ui'
$id = [guid]::NewGuid().ToString('N')
$qTask = 'Renitech-Watchdog-Observe-' + $id
$qRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) $qTask
$qFiles = @('qualify-watchdog-system.ps1','chatbot-watchdog.ps1','chatbot-owned-backend.ps1','chatbot-backend-evidence.ps1')
if (Test-Path -LiteralPath $qRoot) { throw 'Staging path already exists' }
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$acl.SetOwner($adminSid)
foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
[void][IO.Directory]::CreateDirectory($qRoot, $acl)
$actual = Get-Acl -LiteralPath $qRoot
$rules = @($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 2) { throw 'Staging ACL not verified' }
foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
    $matched = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq 'FullControl' -and -not $_.IsInherited })
    if ($matched.Count -ne 1) { throw 'Staging ACL not verified' }
}
foreach ($name in $qFiles) {
    $source = Join-Path (Join-Path $repo 'scripts') $name
    if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected source reparse point' }
    $target = Join-Path $qRoot $name
    [IO.File]::WriteAllBytes($target, [IO.File]::ReadAllBytes($source))
    if ((Get-FileHash -LiteralPath $source).Hash -cne (Get-FileHash -LiteralPath $target).Hash) { throw 'Staged copy mismatch' }
}
Write-Output "Protected diagnostic directory: $qRoot"
```

Do not copy the API key or configuration. The SYSTEM observation will read their
existing locations. The report is exclusively created as `report.json` and inherits
the protected DACL. A pre-existing report makes the runner fail instead of overwrite.

## 2. Register and run the separate temporary task

Run in the same session **only after approval for the SYSTEM test**:

```powershell
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runner = Join-Path $qRoot 'qualify-watchdog-system.ps1'
$qArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runner + '" -RunObservation'
if (Get-ScheduledTask -TaskName $qTask -TaskPath '\' -ErrorAction SilentlyContinue) { throw 'Temporary task name already exists' }
$action = New-ScheduledTaskAction -Execute $shell -Argument $qArguments -WorkingDirectory $qRoot
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
$definition = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $qTask -TaskPath '\' -InputObject $definition | Out-Null
Start-ScheduledTask -TaskName $qTask -TaskPath '\'
```

There is no trigger and no restart-on-failure policy. The runner checks its token
SID is SYSTEM before observing. It dot-sources the watchdog and calls only
`Get-ChatbotWatchdogObservation -TimeoutSeconds 2`. No recovery entry point runs.

## 3. Inspect the result (do not rerun automatically)

```powershell
Get-ScheduledTask -TaskName $qTask -TaskPath '\' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName $qTask -TaskPath '\' | Select-Object LastRunTime,LastTaskResult
$report = Join-Path $qRoot 'report.json'
if (Test-Path -LiteralPath $report) { Get-Content -LiteralPath $report -Raw }
```

PASS requires a finished task, result 0, `AccountSid: S-1-5-18`, `Success: true`,
`State: healthy`, `Reason: health-healthy`, and both verification fields true.
This establishes that the SYSTEM token could read saved configuration, obtain
task/CIM/parent/timestamp/listener evidence, read the existing key and complete the
authenticated health request with repeated evidence checks. No key is reported.

Any other state is not a qualification pass. False verification fields mean
**not established**, not necessarily that every underlying operation failed.
Task result 1 means observation failed qualification; 2 means the runner could
not complete/write its report. Missing/incomplete report or a task timeout is
UNVERIFIED. Do not repeatedly launch or infer successful authentication from
HTTP reachability. Report only contains fixed codes, account identity and UTC time.

## 4. Cleanup / rollback

Wait for the temporary task to finish. Never stop the backend or production task.
If the temporary task is still running/queued, wait or investigate; this cleanup
refuses to terminate it. Run in the same session:

```powershell
$expectedRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) $qTask
if ($qTask -notmatch '^Renitech-Watchdog-Observe-[0-9a-f]{32}$' -or $qRoot -cne $expectedRoot) { throw 'Cleanup path not verified' }
if ((Get-Item -LiteralPath $qRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected staging reparse point' }
$task = Get-ScheduledTask -TaskName $qTask -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) {
    if ($task.State -in @('Running','Queued') -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $shell -or $task.Actions[0].Arguments -cne $qArguments) { throw 'Temporary task not safe to remove' }
    Unregister-ScheduledTask -TaskName $qTask -TaskPath '\' -Confirm:$false
}
foreach ($name in @($qFiles) + @('report.json')) {
    $file = Join-Path $qRoot $name
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}
[IO.Directory]::Delete($qRoot, $false) # Nonrecursive: unexpected contents block removal.
```

Record the sanitized result before removing it if needed. No production rollback
is necessary: only the unique task and staging directory were introduced. If
setup failed partway, inspect that exact directory/task before cleanup; never
substitute wildcard task names, recurse through unknown paths or reset recovery
markers. A successful observation does not approve watchdog activation/recovery.
