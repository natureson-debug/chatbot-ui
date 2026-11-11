param([switch]$RunObservation)
# Copy this file and the three reviewed helpers to a protected directory before
# registering the temporary task. Dot-sourcing this runner performs no actions.
function Get-SystemWatchdogQualificationReport {
    param([scriptblock]$Observe, [scriptblock]$ReadIdentity)
    $report = [ordered]@{
        Version=1; TimestampUtc=[datetime]::UtcNow.ToString('o')
        Account='unverified'; AccountSid=$null; Success=$false
        State='uncertain'; Reason='identity-unverified'
        ConfigurationAndCimVerified=$false; AuthenticatedHealthVerified=$false
    }
    try {
        $sid = & $ReadIdentity
        if ($sid -cne 'S-1-5-18') { return [pscustomobject]$report }
        $report.Account='NT AUTHORITY\SYSTEM'; $report.AccountSid='S-1-5-18'
        $report.Reason='observation-failed'
        $observations = @(& $Observe)
        if ($observations.Count -ne 1) { return [pscustomobject]$report }
        $observation=$observations[0]
        $states=@('healthy','starting','unhealthy','absent','uncertain')
        $reasons=@('backend-task-disabled','task-starting','verified-absence','task-state-unverified',
            'listener-not-ready','process-or-listener-unverified','ownership-or-configuration-unverified',
            'evidence-changed','evidence-unavailable','health-healthy','health-starting','health-unhealthy','health-uncertain')
        if ($observation.State -cnotin $states -or $observation.Reason -cnotin $reasons) { return [pscustomobject]$report }
        $report.State=$observation.State; $report.Reason=$observation.Reason
        # Healthy is returned only after authenticated health AND repeated task,
        # CIM, listener and saved-configuration validation. Other states prove less.
        if ($observation.State -ceq 'healthy' -and $observation.Reason -ceq 'health-healthy') {
            $report.Success=$true
            $report.ConfigurationAndCimVerified=$true
            $report.AuthenticatedHealthVerified=$true
        }
    } catch { # No raw exceptions, paths, command lines or credentials in output.
        $report.State='uncertain'; $report.Reason='observation-failed'
    }
    return [pscustomobject]$report
}

if ($MyInvocation.InvocationName -ne '.' -and $RunObservation) {
    $ErrorActionPreference='Stop'
    try {
        $report = Get-SystemWatchdogQualificationReport -ReadIdentity {
            [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        } -Observe {
            # Dot-source, NEVER execute the watchdog script entry point.
            . (Join-Path $PSScriptRoot 'chatbot-watchdog.ps1')
            Get-ChatbotWatchdogObservation -TimeoutSeconds 2
        }
        # Parent directory is provisioned with SYSTEM/Administrators-only DACL.
        # Exclusive creation prevents overwriting or following an existing report.
        $bytes=[Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json))
        $file=[IO.File]::Open((Join-Path $PSScriptRoot 'report.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        if ($report.Success) { exit 0 }
        exit 1
    } catch { exit 2 } # Report creation failed; no external error data is printed.
}
