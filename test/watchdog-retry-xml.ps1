param([switch]$NativeTask)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\scripts\watchdog-retry-xml.ps1')
$xml='<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers/><Principals/><Settings><Enabled>false</Enabled><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions/></Task>'
$after=Remove-ChatbotTaskRetryPolicy $xml
if($after -match 'RestartOnFailure' -or $after -cne $xml.Replace('<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>','')) {
    # XML serialization expands empty elements with a space; compare DOMs.
    $expected=New-Object Xml.XmlDocument; $expected.LoadXml($xml.Replace('<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>',''))
    if($after -cne $expected.OuterXml){throw 'Unrelated XML changed'}
}
if((Remove-ChatbotTaskRetryPolicy $after) -cne $after){throw 'Transformation not idempotent'}
Write-Output 'PASS: offline XML removal, preservation and idempotence.'
if(-not $NativeTask){return}

$name='AIChatbot-RetryXml-Test-'+[guid]::NewGuid().ToString('N')
$created=$false; $running=$null
try {
    $service=New-Object -ComObject 'Schedule.Service'; $service.Connect()
    $folder=$service.GetFolder('\')
    $definition=$service.NewTask(0)
    $definition.RegistrationInfo.Description='Disposable retry XML qualification; harmless exit only.'
    $definition.Principal.UserId=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $definition.Principal.LogonType=3 # InteractiveToken, no credentials or SYSTEM.
    $definition.Settings.Enabled=$false
    $definition.Settings.ExecutionTimeLimit='PT10M'
    $definition.Settings.MultipleInstances=2
    $definition.Settings.RestartInterval='PT1M'
    $definition.Settings.RestartCount=3
    $definition.Settings.DisallowStartIfOnBatteries=$false
    $definition.Settings.StopIfGoingOnBatteries=$false
    $trigger=$definition.Triggers.Create(1)
    $trigger.StartBoundary=(Get-Date).AddYears(1).ToString('yyyy-MM-ddTHH:mm:ss')
    $trigger.Enabled=$false
    $trigger.Repetition.Interval='PT2M'
    $action=$definition.Actions.Create(0)
    $action.Path=Join-Path $PSHOME 'powershell.exe'
    $action.Arguments='-NoProfile -NonInteractive -Command "exit 0"'
    $registered=$folder.RegisterTaskDefinition($name,$definition,2,$null,$null,3,$null)
    $created=$true
    $before=$registered.Xml
    $securityBefore=$registered.GetSecurityDescriptor(7)
    $proposed=Remove-ChatbotTaskRetryPolicy $before
    $registered=$folder.RegisterTask($name,$proposed,20,$null,$null,3,$null)
    $export=$registered.Xml
    if($export -match '<RestartOnFailure' -or (Remove-ChatbotTaskRetryPolicy $export) -cne $proposed){throw 'Native export changed unrelated properties'}
    if($registered.Definition.Settings.RestartCount -ne 0){throw 'Native retry count is not zero'}
    if($registered.Enabled -or $registered.GetSecurityDescriptor(7) -cne $securityBefore){throw 'Enabled state or security descriptor changed'}
    Write-Output 'PASS: native registration/export; disabled state, security descriptor and full XML preserved except RestartOnFailure.'
    # Explicit test-only enable AFTER verifying the update preserved Disabled.
    # The only trigger remains disabled and a year in the future.
    $registered.Enabled=$true
    $last=$registered.LastRunTime
    $running=$registered.Run($null)
    $timer=[Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 250
        $registered=$folder.GetTask($name)
        if($registered.LastRunTime -gt $last -and $registered.State -notin @(2,4)){break}
        if($timer.Elapsed.TotalSeconds -gt 30){throw 'Temporary execution timeout; no forced stop authorized'}
    } while($true)
    if($registered.LastTaskResult -ne 0){throw 'Harmless action did not succeed'}
    Write-Output 'PASS: native harmless action executed successfully with retries absent.'
} finally {
    if($created){
        $current=$folder.GetTask($name)
        if($current.State -in @(2,4)){Write-Output ('CLEANUP BLOCKED: temporary task still active: '+$name)}
        else {$folder.DeleteTask($name,0); Write-Output 'PASS: temporary task removed.'}
    }
}
