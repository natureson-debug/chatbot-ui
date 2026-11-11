$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'restart-lifecycle-safety.ps1')
. (Join-Path $PSScriptRoot '..\scripts\Test-ChatbotLiveBackendOwnership.ps1')
$exe = 'C:\Users\Admin\Downloads\Chatbot-upgrade-17E2-20261015\llama-b11609-cuda12.4\llama-server.exe'
$powershell = Join-Path $PSHOME 'powershell.exe'
$script:mode = 'ok'; $script:reads = 0
function Get-ScheduledTask {
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "C:\AI\scripts\start-chatbot-ai.ps1"'
    if ($script:mode -eq 'task') { $arguments = '-Command forbidden' }
    [pscustomobject]@{ Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments=$arguments}) }
}
function Get-NetTCPConnection {
    $script:reads++
    [pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=8080;OwningProcess=100}
    if ($script:mode -eq 'listeners') { [pscustomobject]@{LocalAddress='0.0.0.0';LocalPort=8080;OwningProcess=101} }
}
function Get-CimInstance {
    param($Filter, $OperationTimeoutSec, $ErrorAction)
    if ($script:mode -eq 'denied') { throw 'Synthetic sensitive details must never escape' }
    $e = New-Evidence
    $e.Backend.CommandLine = $e.Backend.CommandLine.Replace('--tensor-split 3,2 ', '')
    $e.Parent.CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
    if ($Filter -eq 'ProcessId = 90') {
        if ($script:mode -eq 'parent') { return $null }
        return [pscustomobject]@{ProcessId=90;CreationDate=[datetime]$e.Parent.CreatedAt;ExecutablePath=$powershell;CommandLine=$e.Parent.CommandLine}
    }
    $created = [datetime]$e.Backend.CreatedAt
    if ($script:mode -eq 'changed' -and $script:reads -gt 1) { $created=$created.AddSeconds(1) }
    $path = if ($script:mode -eq 'exe') { 'C:\untrusted.exe' } else { $exe }
    [pscustomobject]@{ProcessId=100;ParentProcessId=90;CreationDate=$created;ExecutablePath=$path;CommandLine=$e.Backend.CommandLine}
    if ($script:mode -eq 'processes' -and $Filter -like 'Name=*') { [pscustomobject]@{ProcessId=101} }
}
function Get-Content {
    param($LiteralPath, [switch]$Raw, $ErrorAction)
    if ($LiteralPath -cne 'C:\AI\config\chatbot-ai-config.json') { throw 'Unexpected file access' }
    $device = if ($script:mode -eq 'mismatch') { 'CUDA0' } else { 'CUDA0,CUDA1' }
    if ($script:mode -eq 'config-change' -and $script:reads -eq 3) { $device='CUDA0' }
    @{model='fixture.gguf';parallel=1;contextSize=32768;device=$device;splitMode='layer';tensorSplit='';gpuLayers=45;verbosity=4;metrics=$true} | ConvertTo-Json -Compress
}
foreach ($name in @('Start-Process','Stop-Process','Start-ScheduledTask','Stop-ScheduledTask','Enable-ScheduledTask','Disable-ScheduledTask','Enter-ChatbotLifecycleLock')) {
    Set-Item -Path ('Function:' + $name) -Value { throw 'Mutation forbidden in diagnostic' }
}
$count = 0
foreach ($case in @('ok','task','listeners','processes','denied','parent','changed','exe','mismatch','config-change')) {
    $script:mode=$case; $script:reads=0
    $result=Test-ChatbotLiveBackendOwnership
    if ($case -eq 'ok') {
        if (-not $result.OwnershipVerified -or -not $result.ConfigurationMatched -or $result.BackendPid -ne 100) { throw 'Valid fixture rejected' }
    } elseif ($case -eq 'mismatch') {
        if (-not $result.OwnershipVerified -or $result.ConfigurationMatched -or $result.Reason -ne 'configuration-mismatch') { throw 'Configuration mismatch misclassified' }
    } elseif ($result.OwnershipVerified -or $result.ConfigurationMatched -or $null -ne $result.BackendPid) { throw 'Unsafe fixture accepted' }
    if (($result | ConvertTo-Json) -match 'sensitive|CommandLine|Authorization|C:\\') { throw 'Diagnostic leaked evidence' }
    $count++
}
Write-Output "PASS: $count live-diagnostic scenarios using mocked cmdlets only."
