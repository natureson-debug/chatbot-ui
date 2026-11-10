$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\chatbot-owned-backend.ps1')

$exe = 'C:\AI\llama.cpp\llama-server.exe'
$launcher = 'C:\AI\scripts\start-chatbot-ai.ps1'
$powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$expected = @($exe, '--model', 'C:\AI\models\fixture.gguf', '--host', '127.0.0.1', '--port', '8080',
    '--api-key-file', 'C:\AI\config\llama-api-key.txt', '--cors-origins', 'http://127.0.0.1:8080',
    '--parallel', '1', '--ctx-size', '32768', '--device', 'CUDA0,CUDA1',
    '--split-mode', 'layer', '--tensor-split', '3,2', '--n-gpu-layers', '45', '--verbosity', '4', '--metrics')

function New-Evidence([int]$BackendPid = 100, [bool]$TaskActionVerified = $true) {
    $backendCommand = '"' + $exe + '" ' +
        '--model C:\AI\models\fixture.gguf --host 127.0.0.1 --port 8080 ' +
        '--api-key-file C:\AI\config\llama-api-key.txt --cors-origins http://127.0.0.1:8080 ' +
        '--parallel 1 --ctx-size 32768 --device CUDA0,CUDA1 --split-mode layer --tensor-split 3,2 ' +
        '--n-gpu-layers 45 --verbosity 4 --metrics'
    $parentCommand = '"' + $powershell + '" -NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
    [pscustomobject]@{
        TaskActionVerified = $TaskActionVerified
        Backend = [pscustomobject]@{
            Pid = $BackendPid; ParentPid = 90; CreatedAt = '2026-11-10T10:00:01.0000000Z'
            Executable = $exe; CommandLine = $backendCommand
        }
        Parent = [pscustomobject]@{
            Pid = 90; CreatedAt = '2026-11-10T10:00:00.0000000Z'
            Executable = $powershell; CommandLine = $parentCommand
        }
        Listeners = @([pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8080; OwningProcess = $BackendPid })
    }
}

$valid = New-Evidence
if (-not (Test-ChatbotBackendEvidence $valid $exe $launcher $powershell '127.0.0.1' 8080 $expected)) {
    throw 'Valid owned multi-GPU process evidence was rejected.'
}

$script:observations = @((New-Evidence -TaskActionVerified $false), (New-Evidence -TaskActionVerified $false))
$script:observationIndex = 0
$script:terminated = [Collections.Generic.List[int]]::new()
$observe = { $script:observations[$script:observationIndex++] }
$terminate = { param($processId) $script:terminated.Add([int]$processId) }
$refused = Invoke-ChatbotOwnedBackendStop -Observe $observe -Terminate $terminate `
    -ExpectedExecutable $exe -LauncherScript $launcher -PowerShellExecutable $powershell `
    -BindAddress '127.0.0.1' -Port 8080 -ExpectedArguments $expected
if ($refused.Stopped -or $script:terminated.Count -ne 0) {
    throw 'Shutdown was not refused when ownership could not be verified.'
}

$script:observations = @((New-Evidence), (New-Evidence -BackendPid 101))
$script:observationIndex = 0
$changed = Invoke-ChatbotOwnedBackendStop -Observe $observe -Terminate $terminate `
    -ExpectedExecutable $exe -LauncherScript $launcher -PowerShellExecutable $powershell `
    -BindAddress '127.0.0.1' -Port 8080 -ExpectedArguments $expected
if ($changed.Stopped -or $script:terminated.Count -ne 0) {
    throw 'Shutdown was not refused when process identity changed.'
}

$script:observations = @((New-Evidence), (New-Evidence))
$script:observationIndex = 0
$stopped = Invoke-ChatbotOwnedBackendStop -Observe $observe -Terminate $terminate `
    -ExpectedExecutable $exe -LauncherScript $launcher -PowerShellExecutable $powershell `
    -BindAddress '127.0.0.1' -Port 8080 -ExpectedArguments $expected
if (-not $stopped.Stopped -or $stopped.Pid -ne 100 -or $script:terminated.Count -ne 1 -or $script:terminated[0] -ne 100) {
    throw 'Verified shutdown did not target the exact listener-owning PID.'
}

Write-Output 'PASS: multi-GPU process identity and repeated-observation shutdown checks.'
