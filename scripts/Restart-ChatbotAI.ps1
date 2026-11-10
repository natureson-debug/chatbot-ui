# Dot-source this file, then call Restart-ChatbotAI from elevated PowerShell.
# Loading this file does not run tasks or restart anything.
. (Join-Path $PSScriptRoot 'chatbot-owned-backend.ps1')

function Restart-ChatbotAI {
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
    param(
        [ValidateRange(5, 120)][int]$StopTimeoutSeconds = 30,
        [ValidateRange(10, 600)][int]$StartupTimeoutSeconds = 300
    )
    if (-not $PSCmdlet.ShouldProcess('AI Chatbot - llama.cpp', 'Pause watchdog, restart scheduled backend, verify readiness')) { return }
    $ErrorActionPreference = 'Stop'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this command from Administrator PowerShell.'
    }
    $backendName = 'AI Chatbot - llama.cpp'
    $watchdogName = 'AI Chatbot - Watchdog'
    $expectedExe = 'C:\Users\Admin\Downloads\Chatbot-upgrade-17E2-20261015\llama-b11609-cuda12.4\llama-server.exe'
    $launcherScript = 'C:\AI\scripts\start-chatbot-ai.ps1'
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    $baseUrl = 'http://127.0.0.1:8080'
    $lock = $null
    $watchdogPaused = $false
    $success = $false
    $headers = $null
    function Assert-TaskAction($Task, [string]$Script) {
        $actions = @($Task.Actions)
        if ($actions.Count -ne 1 -or
            $actions[0].Execute -notin @('powershell.exe', 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe') -or
            $actions[0].Arguments -cne ('-NoProfile -ExecutionPolicy Bypass -File "' + $Script + '"')) {
            throw 'Unexpected scheduled-task action. No restart authorized.'
        }
    }
    function Get-ExpectedBackendArguments($Config) {
        $devices = @('CUDA0')
        if ($null -ne $Config.PSObject.Properties['device']) {
            if ($Config.device -isnot [string]) { throw 'Saved GPU device selection is invalid.' }
            $devices = @($Config.device.Split(',') | ForEach-Object { $_.Trim() })
        }
        if ($devices.Count -eq 0 -or
            @($devices | Where-Object { $_ -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$' }).Count -gt 0 -or
            @($devices | Select-Object -Unique).Count -ne $devices.Count) {
            throw 'Saved GPU device selection is invalid.'
        }
        $availableOutput = @(& $expectedExe --list-devices 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'GPU devices could not be verified.' }
        $available = @($availableOutput | ForEach-Object {
            $match = [regex]::Match([string]$_, '^\s*(CUDA\d+):')
            if ($match.Success) { $match.Groups[1].Value }
        } | Where-Object { $_ })
        foreach ($device in $devices) {
            if ($device -cnotin $available) { throw 'Saved GPU selection is unavailable.' }
        }
        $devices = @($devices | ForEach-Object {
            $selected = $_
            $available | Where-Object { $_ -ieq $selected } | Select-Object -First 1
        })
        $device = $devices -join ','

        $splitMode = 'layer'
        if ($null -ne $Config.PSObject.Properties['splitMode'] -and $null -ne $Config.splitMode) {
            if ($Config.splitMode -isnot [string]) { throw 'Saved split mode is invalid.' }
            $splitMode = $Config.splitMode
        }
        if ($splitMode -cnotin @('none','layer','row','tensor')) { throw 'Saved split mode is invalid.' }

        $tensorSplit = $null
        if ($null -ne $Config.PSObject.Properties['tensorSplit'] -and $null -ne $Config.tensorSplit -and
            $Config.tensorSplit.Trim() -ne '') {
            if ($Config.tensorSplit -isnot [string]) { throw 'Saved tensor split is invalid.' }
            $parts = @($Config.tensorSplit.Split(',') | ForEach-Object { $_.Trim() })
            if ($parts.Count -ne $devices.Count -or $devices.Count -lt 2) { throw 'Saved tensor split is invalid.' }
            foreach ($part in $parts) {
                $proportion = 0.0
                if ($part -notmatch '^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$' -or
                    -not [double]::TryParse($part, [Globalization.NumberStyles]::Float,
                        [Globalization.CultureInfo]::InvariantCulture, [ref]$proportion) -or
                    [double]::IsInfinity($proportion) -or [double]::IsNaN($proportion) -or $proportion -le 0) {
                    throw 'Saved tensor split is invalid.'
                }
            }
            $tensorSplit = $parts -join ','
        }

        $gpuLayers = 37
        if ($null -ne $Config.PSObject.Properties['gpuLayers'] -and $null -ne $Config.gpuLayers) {
            if ($Config.gpuLayers -isnot [int] -and $Config.gpuLayers -isnot [long]) { throw 'Saved GPU layer count is invalid.' }
            if ($Config.gpuLayers -lt 0 -or $Config.gpuLayers -gt 999) { throw 'Saved GPU layer count is invalid.' }
            $gpuLayers = [int]$Config.gpuLayers
        }
        $verbosity = 4
        if ($null -ne $Config.PSObject.Properties['verbosity'] -and $null -ne $Config.verbosity) {
            if ($Config.verbosity -isnot [int] -and $Config.verbosity -isnot [long]) { throw 'Saved verbosity is invalid.' }
            if ($Config.verbosity -lt 0 -or $Config.verbosity -gt 5) { throw 'Saved verbosity is invalid.' }
            $verbosity = [int]$Config.verbosity
        }
        $metrics = $false
        if ($null -ne $Config.PSObject.Properties['metrics'] -and $null -ne $Config.metrics) {
            if ($Config.metrics -isnot [bool]) { throw 'Saved metrics setting is invalid.' }
            $metrics = [bool]$Config.metrics
        }

        $args = @('--model', (Join-Path 'C:\AI\models' $Config.model),
            '--host', '127.0.0.1', '--port', '8080',
            '--api-key-file', 'C:\AI\config\llama-api-key.txt',
            '--cors-origins', 'http://127.0.0.1:8080',
            '--parallel', [string]$Config.parallel,
            '--ctx-size', [string]$Config.contextSize, '--device', $device)
        if ($devices.Count -gt 1) {
            $args += '--split-mode', $splitMode
            if ($null -ne $tensorSplit) { $args += '--tensor-split', $tensorSplit }
        }
        $args += '--n-gpu-layers', [string]$gpuLayers, '--verbosity', [string]$verbosity
        if ($metrics) { $args += '--metrics' }
        return ,(@($expectedExe) + $args)
    }
    function Read-Backends {
        @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -OperationTimeoutSec 2 -ErrorAction Stop)
    }
    function Read-Listeners {
        @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 8080)
    }
    function Read-OwnershipEvidence {
        $task = Get-ScheduledTask -TaskName $backendName -TaskPath '\' -ErrorAction Stop
        Assert-TaskAction $task $launcherScript
        $listeners = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort 8080 -ErrorAction Stop)
        if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -le 0) { return $null }
        $backendProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listeners[0].OwningProcess) -OperationTimeoutSec 2 -ErrorAction Stop
        if ($null -eq $backendProcess) { return $null }
        $parentProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $backendProcess.ParentProcessId) -OperationTimeoutSec 2 -ErrorAction Stop
        if ($null -eq $parentProcess) { return $null }
        $backendCreated = if ($backendProcess.CreationDate -is [datetime]) { $backendProcess.CreationDate.ToUniversalTime().ToString('o') } else { $null }
        $parentCreated = if ($parentProcess.CreationDate -is [datetime]) { $parentProcess.CreationDate.ToUniversalTime().ToString('o') } else { $null }
        [pscustomobject]@{
            TaskActionVerified = $true
            Backend = [pscustomobject]@{
                Pid = [int]$backendProcess.ProcessId; ParentPid = [int]$backendProcess.ParentProcessId
                CreatedAt = $backendCreated; Executable = $backendProcess.ExecutablePath
                CommandLine = $backendProcess.CommandLine
            }
            Parent = [pscustomobject]@{
                Pid = [int]$parentProcess.ProcessId; CreatedAt = $parentCreated
                Executable = $parentProcess.ExecutablePath; CommandLine = $parentProcess.CommandLine
            }
            Listeners = @($listeners | Select-Object LocalAddress, LocalPort, OwningProcess)
        }
    }
    try {
        $backend = Get-ScheduledTask -TaskName $backendName -TaskPath '\'
        $watchdog = Get-ScheduledTask -TaskName $watchdogName -TaskPath '\'
        Assert-TaskAction $backend 'C:\AI\scripts\start-chatbot-ai.ps1'
        Assert-TaskAction $watchdog 'C:\AI\scripts\chatbot-watchdog.ps1'
        if (-not $backend.Settings.Enabled) { throw 'Backend task is disabled. Enable it explicitly before using this command.' }
        $restoreWatchdog = [bool]$watchdog.Settings.Enabled
        $configText = [IO.File]::ReadAllText('C:\AI\config\chatbot-ai-config.json')
        $config = $configText | ConvertFrom-Json
        if (-not ($config.model -is [string]) -or $config.model -notmatch '^[^\\/:]+\.gguf$' -or
            -not (Test-Path -LiteralPath (Join-Path 'C:\AI\models' $config.model) -PathType Leaf) -or
            -not (Test-Path -LiteralPath $expectedExe -PathType Leaf)) { throw 'Configured model or qualified executable is unavailable.' }
        $expectedArguments = Get-ExpectedBackendArguments $config
        $key = [IO.File]::ReadAllText('C:\AI\config\llama-api-key.txt').Trim()
        if ([string]::IsNullOrWhiteSpace($key)) { throw 'API-key file is empty.' }
        $headers = @{ Authorization = 'Bearer ' + $key }
        $key = $null
        . 'C:\AI\scripts\chatbot-lifecycle-lock.ps1'
        $lock = Enter-ChatbotLifecycleLock -TimeoutMilliseconds 0
        if ($lock.State -ne 'acquired') { throw 'Another lifecycle operation or an unverifiable lock prevents restart.' }
        Disable-ScheduledTask -TaskName $watchdogName -TaskPath '\' | Out-Null
        $watchdogPaused = $true
        $watchdog = Get-ScheduledTask -TaskName $watchdogName -TaskPath '\'
        if ($watchdog.Settings.Enabled -or $watchdog.State -in @('Running','Queued')) {
            throw 'Watchdog is still active or queued. No backend stop was issued.'
        }
        $backend = Get-ScheduledTask -TaskName $backendName -TaskPath '\'
        if ($backend.State -notin @('Running','Ready')) { throw 'Backend task state is uncertain.' }
        if ($backend.State -eq 'Running') {
            Write-Host 'Stopping the backend scheduled task...'
            Stop-ScheduledTask -TaskName $backendName -TaskPath '\'
        }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $shutdownAttempted = $false
        do {
            $task = Get-ScheduledTask -TaskName $backendName -TaskPath '\'
            $processes = @(Read-Backends)
            $listeners = @(Read-Listeners)
            if ($task.State -eq 'Ready' -and $processes.Count -eq 0 -and $listeners.Count -eq 0) { break }
            if (-not $shutdownAttempted -and $timer.Elapsed.TotalSeconds -ge 2 -and
                $processes.Count -eq 1 -and $listeners.Count -eq 1) {
                $termination = {
                    param($ProcessId)
                    Stop-Process -Id ([int]$ProcessId) -Force -ErrorAction Stop
                }
                $stopped = Invoke-ChatbotOwnedBackendStop -Observe { Read-OwnershipEvidence } `
                    -Terminate $termination -ExpectedExecutable $expectedExe -LauncherScript $launcherScript `
                    -PowerShellExecutable $powershellExe -BindAddress '127.0.0.1' -Port 8080 `
                    -ExpectedArguments $expectedArguments
                if (-not $stopped.Stopped) {
                    throw 'Backend remains after task stop and ownership could not be verified. No process was terminated and no replacement will start.'
                }
                Write-Host ('Stopped verified llama-server process ' + $stopped.Pid + '.')
                $shutdownAttempted = $true
            }
            if ($timer.Elapsed.TotalSeconds -ge $StopTimeoutSeconds) {
                throw 'Backend task, process, or listener remains after the verified shutdown attempt. No replacement will start.'
            }
            Start-Sleep -Milliseconds 250
        } while ($true)
        if ([IO.File]::ReadAllText('C:\AI\config\chatbot-ai-config.json') -cne $configText) { throw 'Configuration changed during restart; start cancelled.' }
        Write-Host ('Starting saved model: ' + $config.model)
        $timer.Restart()
        Start-ScheduledTask -TaskName $backendName -TaskPath '\'
        do {
            if ($timer.Elapsed.TotalSeconds -ge $StartupTimeoutSeconds) { throw 'Backend readiness timed out. No retry or termination issued.' }
            $processes = @(Read-Backends)
            $listeners = @(Read-Listeners)
            if ($processes.Count -gt 1 -or $listeners.Count -gt 1) { throw 'Multiple backend processes or listeners detected.' }
            if ($listeners.Count -eq 1) {
                $listener = $listeners[0]
                if ($processes.Count -ne 1 -or $listener.LocalAddress -ne '127.0.0.1' -or
                    $listener.OwningProcess -ne $processes[0].ProcessId -or
                    $processes[0].ExecutablePath -ine $expectedExe) { throw 'Backend listener identity mismatch.' }
                $evidence = Read-OwnershipEvidence
                if (-not (Test-ChatbotBackendEvidence $evidence $expectedExe $launcherScript $powershellExe `
                        '127.0.0.1' 8080 $expectedArguments)) {
                    throw 'Running backend arguments or launcher ownership do not match the saved configuration.'
                }
                $ready = $false
                try {
                    $health = Invoke-RestMethod "$baseUrl/health" -Headers $headers -TimeoutSec 2 -MaximumRedirection 0
                    $ready = $health.status -eq 'ok'
                } catch { # Never print HTTP exceptions or authorization headers.
                    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in @(401,403)) { throw 'Backend authentication failed.' }
                }
                if ($ready) {
                    try { $models = Invoke-RestMethod "$baseUrl/v1/models" -Headers $headers -TimeoutSec 2 -MaximumRedirection 0 }
                    catch { throw 'Unable to verify loaded model.' }
                    $entries = @($models.data)
                    if ($entries.Count -ne 1 -or [IO.Path]::GetFileName([string]$entries[0].id) -cne $config.model) { throw 'Loaded model does not match the saved configuration.' }
                    if ($timer.Elapsed.TotalSeconds -ge $StartupTimeoutSeconds) { throw 'Readiness deadline exceeded.' }
                    if ($restoreWatchdog) { Enable-ScheduledTask -TaskName $watchdogName -TaskPath '\' | Out-Null }
                    $success = $true
                    [pscustomobject]@{ Status='Ready'; Model=$config.model; PID=$listener.OwningProcess; Endpoint=$baseUrl; WatchdogEnabled=$restoreWatchdog }
                    return
                }
            }
            Start-Sleep -Milliseconds 500
        } while ($true)
    } finally {
        $headers = $null
        if ($null -ne $lock) { Exit-ChatbotLifecycleLock -Lock $lock }
        if ($watchdogPaused -and -not $success) {
            Write-Warning 'Restart did not complete. Watchdog remains disabled for inspection. A backend may still be starting; do not launch another instance blindly.'
        }
    }
}
