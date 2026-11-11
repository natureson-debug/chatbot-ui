# Shared evidence collection and argument construction; definitions only.
function Assert-TaskAction($Task, [string]$Script) {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1 -or
        $actions[0].Execute -notin @('powershell.exe', 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe') -or
        $actions[0].Arguments -cne ('-NoProfile -ExecutionPolicy Bypass -File "' + $Script + '"')) {
        throw 'Unexpected scheduled-task action. No restart authorized.'
    }
}
function Get-ExpectedBackendArguments($Config, [switch]$NoDeviceProbe) {
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
    # Diagnostics compare configured IDs without executing device enumeration.
    if (-not $NoDeviceProbe) {
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
    }
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
    $listeners = @(Read-Listeners)
    $processes = @(Read-Backends)
    if ($processes.Count -ne 1 -or $listeners.Count -ne 1 -or
        $listeners[0].LocalAddress -cne '127.0.0.1' -or
        $processes[0].ProcessId -ne $listeners[0].OwningProcess) { return $null }
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
