$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'restart-lifecycle-safety.ps1')
. (Join-Path $PSScriptRoot '..\scripts\chatbot-watchdog.ps1')
$script:checks = 0
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function PolicyCase($States, $LockState='acquired', $Latch=$false, $FailStart=$false) {
    $script:states=$States; $script:index=0; $script:launches=0; $script:clock=0
    $script:latched=$Latch; $script:released=0; $script:failStart=$FailStart; $script:lockState=$LockState
    $providers=@{
        Enter={ [pscustomobject]@{State=$script:lockState} }
        Exit={param($lock) $script:released++}
        Observe={ $i=[Math]::Min($script:index++, $script:states.Count-1); [pscustomobject]@{State=$script:states[$i];Reason='fixture'} }
        Claim={ if ($script:latched) { return $false }; $script:latched=$true; return $true }
        Start={ $script:launches++; if ($script:failStart) { throw 'synthetic secret' } }
        Complete={ $script:latched=$false }
        Now={ $script:clock }
        Wait={param($seconds) $script:clock+=$seconds}
        Log={param($record) if (($record | ConvertTo-Json) -match 'synthetic secret') { throw 'Secret leaked' } }
    }
    Invoke-ChatbotWatchdogPolicy $providers 3 1
}
foreach ($state in @('healthy','starting','unhealthy','uncertain')) {
    $r=PolicyCase @($state)
    Assert ($r.State -eq $state -and $script:launches -eq 0 -and $script:released -eq 1) 'Existing backend recovery attempted'
}
$r=PolicyCase @('absent','absent','starting','healthy')
Assert ($r.State -eq 'healthy' -and $script:launches -eq 1 -and -not $script:latched) 'Single verified recovery failed'
$r=PolicyCase @('absent','uncertain')
Assert ($script:launches -eq 0) 'Unstable absence launched'
$r=PolicyCase @('absent') 'busy'
Assert ($script:launches -eq 0 -and $script:index -eq 0) 'Busy lock ignored'
$r=PolicyCase @('absent') 'abandoned'
Assert ($script:launches -eq 0) 'Abandoned lock ignored'
$r=PolicyCase @('absent') 'acquired' $false $true
Assert ($script:launches -eq 1 -and $script:latched -and $r.State -eq 'uncertain') 'Failed task request was not latched'
$r=PolicyCase @('absent','absent','starting')
Assert ($r.Reason -eq 'recovery-timeout' -and $script:launches -eq 1 -and $script:latched) 'Timeout did not block retries'
$r=PolicyCase @('absent') 'acquired' $true
Assert ($script:launches -eq 0 -and $r.Reason -eq 'recovery-latched') 'Later invocation retried ambiguous recovery'
$r=PolicyCase @('absent','absent','unhealthy')
Assert ($r.State -eq 'unhealthy' -and $script:launches -eq 1 -and $script:latched) 'Unhealthy recovery continued'

# Actual HTTP helper, synthetic key and HTTP responses. No file/network IO.
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $Headers, $TimeoutSec, $MaximumRedirection, $ErrorAction)
    Assert ($TimeoutSec -eq 2 -and $MaximumRedirection -eq 0 -and $Uri -eq 'http://127.0.0.1:8080/health') 'HTTP bound or target changed'
    Assert ($Headers.Authorization -eq 'Bearer synthetic-key') 'Authentication missing'
    [pscustomobject]@{StatusCode=$script:httpStatus;Content=$script:httpBody}
}
foreach ($case in @(@(200,'{"status":"ok"}','healthy'),@(503,'{}','starting'),@(401,'{}','unhealthy'),@(200,'{}','unhealthy'),@(200,'not-json','uncertain'))) {
    $script:httpStatus=$case[0]; $script:httpBody=$case[1]
    Assert ((Get-ChatbotWatchdogHealth 2 { 'synthetic-key' }) -eq $case[2]) 'Health classification failed'
}

# Actual collector and validators; all CIM/task/file observations are synthetic.
$exe='C:\Users\Admin\Downloads\Chatbot-upgrade-17E2-20261015\llama-b11609-cuda12.4\llama-server.exe'
$powershell=Join-Path $PSHOME 'powershell.exe'
$script:mode='healthy'; $script:observations=0
function Get-ScheduledTask {
    $arguments='-NoProfile -ExecutionPolicy Bypass -File "C:\AI\scripts\start-chatbot-ai.ps1"'
    if ($script:mode -eq 'task') { $arguments='-Command forbidden' }
    $taskState=if($script:mode -eq 'loading-no-listener'){'Running'}else{'Ready'}
    [pscustomobject]@{State=$taskState;Settings=[pscustomobject]@{Enabled=$true};Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments=$arguments})}
}
function Get-NetTCPConnection {
    $script:observations++
    if ($script:mode -in @('absent','loading-no-listener')) { return }
    $id=if($script:mode -eq 'foreign'){101}else{100}
    [pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=8080;OwningProcess=$id}
    if($script:mode -eq 'ambiguous'){[pscustomobject]@{LocalAddress='0.0.0.0';LocalPort=8080;OwningProcess=101}}
}
function Get-CimInstance {
    param($Filter,$OperationTimeoutSec,$ErrorAction)
    if($script:mode -eq 'denied'){throw 'synthetic private error'}
    if($script:mode -eq 'absent'){return}
    $e=New-Evidence
    if($Filter -eq 'ProcessId = 90') { return [pscustomobject]@{ProcessId=90;CreationDate=[datetime]$e.Parent.CreatedAt;ExecutablePath=$powershell;CommandLine=$e.Parent.CommandLine} }
    $created=[datetime]$e.Backend.CreatedAt
    if($script:mode -eq 'changed' -and $script:observations -ge 3){$created=$created.AddSeconds(1)}
    [pscustomobject]@{ProcessId=100;ParentProcessId=90;CreationDate=$created;ExecutablePath=$exe;CommandLine=$e.Backend.CommandLine}
}
function Get-Content {
    param($LiteralPath,[switch]$Raw,$ErrorAction)
    Assert ($LiteralPath -eq 'C:\AI\config\chatbot-ai-config.json') 'Unexpected file read'
    $device=if($script:mode -eq 'mismatch'){'CUDA0'}else{'CUDA0,CUDA1'}
    @{model='fixture.gguf';parallel=1;contextSize=32768;device=$device;splitMode='layer';tensorSplit= $(if($device -eq 'CUDA0'){''}else{'3,2'});gpuLayers=45;verbosity=4;metrics=$true}|ConvertTo-Json -Compress
}
function Get-ChatbotWatchdogHealth { param($TimeoutSeconds) if($script:mode -in @('starting','unhealthy')){return $script:mode}; return 'healthy' }
foreach($case in @('healthy','starting','loading-no-listener','unhealthy','absent','foreign','ambiguous','denied','changed','task','mismatch')) {
    $script:mode=$case; $script:observations=0
    $r=Get-ChatbotWatchdogObservation 2
    $expected=if($case -eq 'loading-no-listener'){'starting'}elseif($case -in @('healthy','starting','unhealthy','absent')){$case}else{'uncertain'}
    Assert ($r.State -eq $expected) ('Observation classification failed: '+$case)
    Assert (($r|ConvertTo-Json) -notmatch 'private|CommandLine|Authorization') 'Evidence leaked'
}
Write-Output "PASS: $script:checks watchdog assertions, injected providers only."
