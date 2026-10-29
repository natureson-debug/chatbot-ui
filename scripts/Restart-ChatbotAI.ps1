# Dot-source this file, then call Restart-ChatbotAI from elevated PowerShell.
# Loading this file does not run tasks or restart anything.
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
    function Read-Backends {
        @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -OperationTimeoutSec 2 -ErrorAction Stop)
    }
    function Read-Listeners {
        @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 8080)
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
        do {
            $task = Get-ScheduledTask -TaskName $backendName -TaskPath '\'
            $processes = @(Read-Backends)
            $listeners = @(Read-Listeners)
            if ($task.State -eq 'Ready' -and $processes.Count -eq 0 -and $listeners.Count -eq 0) { break }
            if ($timer.Elapsed.TotalSeconds -ge $StopTimeoutSeconds) {
                throw 'Backend or listener remains. It may be watchdog-launched. No process was killed and no replacement will start.'
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
