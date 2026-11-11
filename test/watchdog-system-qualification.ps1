$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\qualify-watchdog-system.ps1')
$script:count=0
function Assert($Value) { if(-not $Value){throw 'Qualification assertion failed'}; $script:count++ }
$system={ 'S-1-5-18' }
$healthy={ [pscustomobject]@{State='healthy';Reason='health-healthy';Secret='synthetic-private'} }
$r=Get-SystemWatchdogQualificationReport $healthy $system
Assert ($r.Success -and $r.AccountSid -eq 'S-1-5-18' -and $r.ConfigurationAndCimVerified -and $r.AuthenticatedHealthVerified)
Assert (($r|ConvertTo-Json) -notmatch 'synthetic-private|Secret')
$r=Get-SystemWatchdogQualificationReport { throw 'Must not observe non-SYSTEM account' } { 'S-1-5-21-fixture' }
Assert (-not $r.Success -and $r.Reason -eq 'identity-unverified')
foreach($case in @(@('starting','health-starting'),@('unhealthy','health-unhealthy'),@('uncertain','evidence-unavailable'),@('absent','verified-absence'))) {
    $observe={ [pscustomobject]@{State=$case[0];Reason=$case[1]} }
    $r=Get-SystemWatchdogQualificationReport $observe $system
    Assert (-not $r.Success -and -not $r.AuthenticatedHealthVerified -and $r.State -eq $case[0])
}
foreach($observe in @({throw 'synthetic-private'}, {[pscustomobject]@{State='healthy';Reason='synthetic-private'}}, {1;2}, {$null})) {
    $r=Get-SystemWatchdogQualificationReport $observe $system
    Assert (-not $r.Success -and ($r|ConvertTo-Json) -notmatch 'synthetic-private')
}
# Inspect the actual runner AST: only dot-source the candidate, never invoke its
# recovery entry point. This test never creates a task, report or Windows identity.
$t=$null; $e=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\scripts\qualify-watchdog-system.ps1'),[ref]$t,[ref]$e)
Assert ($e.Count -eq 0)
$commands=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true))
Assert (@($commands | Where-Object { $_.GetCommandName() -match '^(Invoke-ChatbotWatchdog|Start-|Stop-|Register-|Unregister-|Enable-|Disable-|Enter-ChatbotLifecycleLock)' }).Count -eq 0)
Assert (@($commands | Where-Object { $_.GetCommandName() -eq 'Get-ChatbotWatchdogObservation' }).Count -eq 1)
Assert (@($commands | Where-Object { $_.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot }).Count -eq 1)
Write-Output "PASS: $script:count qualification assertions; no native SYSTEM execution."
