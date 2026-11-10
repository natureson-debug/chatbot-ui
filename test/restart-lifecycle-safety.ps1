$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\chatbot-owned-backend.ps1')

$exe = 'C:\AI\llama.cpp\llama-server.exe'
$launcher = 'C:\AI\scripts\start-chatbot-ai.ps1'
$powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$modelDirectory = 'C:\AI\models'
$expected = @($exe, '--model', 'C:\AI\models\fixture.gguf', '--host', '127.0.0.1', '--port', '8080',
    '--api-key-file', 'C:\AI\config\llama-api-key.txt', '--cors-origins', 'http://127.0.0.1:8080',
    '--parallel', '1', '--ctx-size', '32768', '--device', 'CUDA0,CUDA1',
    '--split-mode', 'layer', '--tensor-split', '3,2', '--n-gpu-layers', '45', '--verbosity', '4', '--metrics')

function New-Evidence {
    param(
        [string]$Device = 'CUDA0,CUDA1',
        [int]$BackendPid = 100,
        [int]$ParentPid = 90,
        [string]$BackendCreatedAt = '2026-11-10T10:00:01.0000000Z',
        [string]$ParentCreatedAt = '2026-11-10T10:00:00.0000000Z',
        [string]$BackendExecutable = $exe,
        [string]$ParentExecutable = $powershell,
        [string]$ParentLauncher = $launcher,
        [string]$ListenerAddress = '127.0.0.1',
        [int]$ListenerPort = 8080,
        [int]$ListenerPid = -1,
        [bool]$TaskActionVerified = $true
    )
    $backendArguments = @(
        '--model C:\AI\models\fixture.gguf --host 127.0.0.1 --port 8080 ' +
        '--api-key-file C:\AI\config\llama-api-key.txt --cors-origins http://127.0.0.1:8080 ' +
        '--parallel 1 --ctx-size 32768 --device ' + $Device
    )
    if ($Device.Contains(',')) { $backendArguments += '--split-mode layer --tensor-split 3,2' }
    $backendArguments += '--n-gpu-layers 45 --verbosity 4 --metrics'
    $backendCommand = '"' + $exe + '" ' + ($backendArguments -join ' ')
    $parentCommand = '"' + $ParentExecutable + '" -NoProfile -ExecutionPolicy Bypass -File "' + $ParentLauncher + '"'
    if ($ListenerPid -lt 0) { $ListenerPid = $BackendPid }
    [pscustomobject]@{
        TaskActionVerified = $TaskActionVerified
        Backend = [pscustomobject]@{
            Pid = $BackendPid; ParentPid = $ParentPid; CreatedAt = $BackendCreatedAt
            Executable = $BackendExecutable; CommandLine = $backendCommand
        }
        Parent = [pscustomobject]@{
            Pid = $ParentPid; CreatedAt = $ParentCreatedAt
            Executable = $ParentExecutable; CommandLine = $parentCommand
        }
        Listeners = @([pscustomobject]@{
            LocalAddress = $ListenerAddress; LocalPort = $ListenerPort; OwningProcess = $ListenerPid
        })
    }
}

function Invoke-StopCase([object[]]$Observations) {
    $script:observations = $Observations
    $script:observationIndex = 0
    $script:terminated = [Collections.Generic.List[int]]::new()
    $observe = { $script:observations[$script:observationIndex++] }
    $terminate = { param($processId) $script:terminated.Add([int]$processId) }
    $result = Invoke-ChatbotOwnedBackendStop -Observe $observe -Terminate $terminate `
        -ExpectedExecutable $exe -LauncherScript $launcher -PowerShellExecutable $powershell `
        -BindAddress '127.0.0.1' -Port 8080 -ModelDirectory $modelDirectory
    return [pscustomobject]@{ Result = $result; Terminated = $script:terminated }
}

$singleGpu = New-Evidence -Device 'CUDA0'
$multiGpu = New-Evidence -Device 'CUDA0,CUDA1'
foreach ($evidence in @($singleGpu, $multiGpu)) {
    if (-not (Test-ChatbotBackendOwnershipEvidence $evidence $exe $launcher $powershell `
            '127.0.0.1' 8080 $modelDirectory)) { throw 'Safe existing backend arguments were rejected.' }
}

$singleToMulti = Invoke-StopCase @($singleGpu, (New-Evidence -Device 'CUDA0'))
if (-not $singleToMulti.Result.Stopped -or $singleToMulti.Terminated.Count -ne 1 -or $singleToMulti.Terminated[0] -ne 100) {
    throw 'Existing CUDA0 backend was not eligible for verified shutdown after saving CUDA0+CUDA1.'
}
$multiToSingle = Invoke-StopCase @($multiGpu, (New-Evidence -Device 'CUDA0,CUDA1'))
if (-not $multiToSingle.Result.Stopped -or $multiToSingle.Terminated.Count -ne 1 -or $multiToSingle.Terminated[0] -ne 100) {
    throw 'Existing CUDA0+CUDA1 backend was not eligible for verified shutdown after saving CUDA0.'
}

$unexpectedExe = Invoke-StopCase @(
    (New-Evidence -BackendExecutable 'C:\Temp\llama-server.exe'),
    (New-Evidence -BackendExecutable 'C:\Temp\llama-server.exe'))
if ($unexpectedExe.Result.Stopped -or $unexpectedExe.Terminated.Count -ne 0) {
    throw 'Shutdown was not refused for an unexpected backend executable.'
}
$unexpectedLauncher = Invoke-StopCase @(
    (New-Evidence -ParentLauncher 'C:\Temp\start-chatbot-ai.ps1'),
    (New-Evidence -ParentLauncher 'C:\Temp\start-chatbot-ai.ps1'))
if ($unexpectedLauncher.Result.Stopped -or $unexpectedLauncher.Terminated.Count -ne 0) {
    throw 'Shutdown was not refused for an unexpected launcher.'
}
$unverifiedTask = Invoke-StopCase @(
    (New-Evidence -TaskActionVerified $false),
    (New-Evidence -TaskActionVerified $false))
if ($unverifiedTask.Result.Stopped -or $unverifiedTask.Terminated.Count -ne 0) {
    throw 'Shutdown was not refused when the scheduled-task action was unverified.'
}

$changedIdentity = Invoke-StopCase @(
    (New-Evidence),
    (New-Evidence -BackendCreatedAt '2026-11-10T10:00:02.0000000Z'))
if ($changedIdentity.Result.Stopped -or $changedIdentity.Terminated.Count -ne 0) {
    throw 'Shutdown was not refused after backend process identity changed.'
}
$changedPid = Invoke-StopCase @(
    (New-Evidence),
    (New-Evidence -BackendPid 101))
if ($changedPid.Result.Stopped -or $changedPid.Terminated.Count -ne 0) {
    throw 'Shutdown was not refused after backend PID changed.'
}
$changedListener = Invoke-StopCase @(
    (New-Evidence),
    (New-Evidence -ListenerPort 8081))
if ($changedListener.Result.Stopped -or $changedListener.Terminated.Count -ne 0) {
    throw 'Shutdown was not refused after listener identity changed.'
}
$multipleListeners = New-Evidence
$multipleListeners.Listeners += [pscustomobject]@{
    LocalAddress = '127.0.0.1'; LocalPort = 8080; OwningProcess = 101
}
$ambiguous = Invoke-StopCase @($multipleListeners, $multipleListeners)
if ($ambiguous.Result.Stopped -or $ambiguous.Terminated.Count -ne 0) {
    throw 'Shutdown was not refused for multiple listeners.'
}

if (Test-ChatbotBackendEvidence $singleGpu $exe $launcher $powershell '127.0.0.1' 8080 $expected) {
    throw 'Readiness accepted a newly started backend with arguments that differ from saved multi-GPU settings.'
}
if (-not (Test-ChatbotBackendEvidence $multiGpu $exe $launcher $powershell '127.0.0.1' 8080 $expected)) {
    throw 'Readiness rejected a backend matching the saved configuration.'
}

Write-Output 'PASS: configuration-independent shutdown ownership, refusal cases, and exact readiness checks.'
