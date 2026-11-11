param(
    [ValidateRange(1, 600)][int]$StartupTimeoutSeconds = 300,
    [ValidateRange(1, 10)][int]$PollIntervalSeconds = 1,
    [ValidateRange(1, 10)][int]$HttpTimeoutSeconds = 2
)
# Repository candidate only. Dot-sourcing defines functions without running them.
. (Join-Path $PSScriptRoot 'chatbot-owned-backend.ps1')
. (Join-Path $PSScriptRoot 'chatbot-backend-evidence.ps1')

function Invoke-ChatbotWatchdogPolicy {
    param([hashtable]$Providers, [double]$DeadlineSeconds = 300, [double]$PollSeconds = 1)
    $lock = $null
    $attempted = $false
    function Outcome([string]$State, [string]$Reason) {
        $record = [pscustomobject]@{ State=$State; Reason=$Reason; RecoveryAttempted=$attempted }
        & $Providers.Log $record
        return $record
    }
    try {
        $lock = & $Providers.Enter
        if ($lock.State -ne 'acquired') { return (Outcome 'uncertain' 'lock-unavailable') }
        $state = & $Providers.Observe
        if ($state.State -ne 'absent') { return (Outcome $state.State $state.Reason) }
        # Repeat absence under the same lock immediately before admission.
        $state = & $Providers.Observe
        if ($state.State -ne 'absent') { return (Outcome $state.State 'absence-not-stable') }
        # Durable, exclusive marker is written BEFORE the one task request. A
        # crash, timeout or task-call error cannot authorize another invocation.
        if (-not (& $Providers.Claim)) { return (Outcome 'uncertain' 'recovery-latched') }
        $attempted = $true
        $started = & $Providers.Now
        & $Providers.Start
        while ($true) {
            if (((& $Providers.Now) - $started) -ge $DeadlineSeconds) { return (Outcome 'uncertain' 'recovery-timeout') }
            $state = & $Providers.Observe
            if (((& $Providers.Now) - $started) -ge $DeadlineSeconds) { return (Outcome 'uncertain' 'recovery-timeout') }
            if ($state.State -eq 'healthy') {
                & $Providers.Complete
                return (Outcome 'healthy' 'recovery-verified')
            }
            if ($state.State -notin @('starting','absent')) { return (Outcome $state.State 'recovery-not-verified') }
            & $Providers.Wait $PollSeconds
        }
    } catch {
        return (Outcome 'uncertain' 'observation-or-recovery-failed')
    } finally {
        if ($null -ne $lock) { & $Providers.Exit $lock }
    }
}

function Get-ChatbotWatchdogHealth {
    param([int]$TimeoutSeconds, [scriptblock]$ReadKey = { [IO.File]::ReadAllText('C:\AI\config\llama-api-key.txt').Trim() })
    $headers = $null
    try {
        $key = & $ReadKey
        if ([string]::IsNullOrWhiteSpace($key)) { return 'uncertain' }
        $headers = @{ Authorization = 'Bearer ' + $key }; $key = $null
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/health' `
                -Headers $headers -TimeoutSec $TimeoutSeconds -MaximumRedirection 0 -ErrorAction Stop
        } catch {
            # 503 is llama.cpp's loading/unavailable response, never health success.
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 503) { return 'starting' }
            if ($_.Exception.Response) { return 'unhealthy' }
            return 'uncertain'
        }
        if ([int]$response.StatusCode -eq 503) { return 'starting' }
        if ([int]$response.StatusCode -ne 200) { return 'unhealthy' }
        $body = $response.Content | ConvertFrom-Json -ErrorAction Stop
        if ($body.status -ceq 'ok') { return 'healthy' }
        if ($body.status -ceq 'loading') { return 'starting' }
        return 'unhealthy'
    } catch { return 'uncertain' }
    finally { $headers = $null; $key = $null }
}

function Get-ChatbotWatchdogObservation {
    param([int]$TimeoutSeconds = 2)
    $ErrorActionPreference = 'Stop'
    $backendName = 'AI Chatbot - llama.cpp'
    $launcherScript = 'C:\AI\scripts\start-chatbot-ai.ps1'
    $expectedExe = 'C:\Users\Admin\Downloads\Chatbot-upgrade-17E2-20261015\llama-b11609-cuda12.4\llama-server.exe'
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    function State([string]$Value, [string]$Reason) { [pscustomobject]@{State=$Value;Reason=$Reason} }
    try {
        $task = Get-ScheduledTask -TaskName $backendName -TaskPath '\' -ErrorAction Stop
        Assert-TaskAction $task $launcherScript
        $processes = @(Read-Backends); $listeners = @(Read-Listeners)
        if ($processes.Count -eq 0 -and $listeners.Count -eq 0) {
            if (-not $task.Settings.Enabled) { return (State 'uncertain' 'backend-task-disabled') }
            if ($task.State -in @('Running','Queued')) { return (State 'starting' 'task-starting') }
            if ($task.State -eq 'Ready') { return (State 'absent' 'verified-absence') }
            return (State 'uncertain' 'task-state-unverified')
        }
        # Loading is provisional, not verified ownership or recovery success.
        # Wait only for one expected executable while its task is running.
        if ($processes.Count -eq 1 -and $listeners.Count -eq 0 -and $task.State -eq 'Running' -and
            $processes[0].CreationDate -is [datetime] -and
            (Get-ChatbotNormalizedPath $processes[0].ExecutablePath) -ceq (Get-ChatbotNormalizedPath $expectedExe)) {
            return (State 'starting' 'listener-not-ready')
        }
        # Otherwise a missing listener cannot satisfy ownership verification.
        if ($processes.Count -ne 1 -or $listeners.Count -ne 1) { return (State 'uncertain' 'process-or-listener-unverified') }
        $before = Read-OwnershipEvidence
        $configText = Get-Content -LiteralPath 'C:\AI\config\chatbot-ai-config.json' -Raw -ErrorAction Stop
        $expected = Get-ExpectedBackendArguments ($configText | ConvertFrom-Json) -NoDeviceProbe
        if (-not (Test-ChatbotBackendEvidence $before $expectedExe $launcherScript $powershellExe '127.0.0.1' 8080 $expected)) {
            return (State 'uncertain' 'ownership-or-configuration-unverified')
        }
        $health = Get-ChatbotWatchdogHealth $TimeoutSeconds
        $after = Read-OwnershipEvidence
        if (-not (Test-ChatbotBackendEvidence $after $expectedExe $launcherScript $powershellExe '127.0.0.1' 8080 $expected) -or
            ($before | ConvertTo-Json -Depth 5 -Compress) -cne ($after | ConvertTo-Json -Depth 5 -Compress) -or
            $configText -cne (Get-Content -LiteralPath 'C:\AI\config\chatbot-ai-config.json' -Raw -ErrorAction Stop)) {
            return (State 'uncertain' 'evidence-changed')
        }
        return (State $health ('health-' + $health))
    } catch { return (State 'uncertain' 'evidence-unavailable') }
}

function Invoke-ChatbotWatchdog {
    param([int]$StartupSeconds = 300, [int]$PollSeconds = 1, [int]$HttpSeconds = 2)
    $ErrorActionPreference = 'Stop'
    # Reuse the installed mutex contract; no second lock implementation.
    . 'C:\AI\scripts\chatbot-lifecycle-lock.ps1'
    $marker = 'C:\AI\logs\watchdog-recovery.pending'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $providers = @{
        Enter = { Enter-ChatbotLifecycleLock -TimeoutMilliseconds 0 }
        Exit = { param($Lock) Exit-ChatbotLifecycleLock -Lock $Lock }
        Observe = { Get-ChatbotWatchdogObservation -TimeoutSeconds $HttpSeconds }
        Claim = {
            try {
                $file = [IO.File]::Open($marker, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $file.Flush($true) } finally { $file.Dispose() }
                $script:watchdogClaimed = $true
                return $true
            } catch { return $false }
        }
        Start = {
            if ((Get-ChatbotWatchdogObservation -TimeoutSeconds $HttpSeconds).State -ne 'absent') { throw 'absence-changed' }
            Start-ScheduledTask -TaskName 'AI Chatbot - llama.cpp' -TaskPath '\' -ErrorAction Stop
        }
        Complete = { if ($script:watchdogClaimed) { [IO.File]::Delete($marker); $script:watchdogClaimed = $false } }
        Now = { $timer.Elapsed.TotalSeconds }
        Wait = { param($Seconds) Start-Sleep -Seconds $Seconds }
        Log = {
            param($Record)
            # Only fixed state/reason codes; never external exception text.
            Add-Content -LiteralPath 'C:\AI\logs\watchdog.log' -Value ($Record | ConvertTo-Json -Compress) -ErrorAction Stop
        }
    }
    $script:watchdogClaimed = $false
    try { Invoke-ChatbotWatchdogPolicy $providers $StartupSeconds $PollSeconds }
    finally { $timer.Stop() }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $result = Invoke-ChatbotWatchdog $StartupTimeoutSeconds $PollIntervalSeconds $HttpTimeoutSeconds
        $result
        if ($result.State -in @('healthy','starting')) { exit 0 }
        exit 1
    } catch { Write-Output 'Watchdog unavailable; no further recovery authorized.'; exit 1 }
}
