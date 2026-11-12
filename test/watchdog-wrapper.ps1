$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$template=[IO.File]::ReadAllText((Join-Path $repo 'scripts\watchdog-production-wrapper.ps1'))
$candidate='C:\AI\chatbot-ui\scripts\chatbot-watchdog.ps1'
if (-not $template.Contains("& '$candidate'")) { throw 'Wrapper target changed; review fixture substitution' }
$root=Join-Path ([IO.Path]::GetTempPath()) ('watchdog-wrapper-test-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$count=0
try {
    foreach($case in @('success','failure','throw','missing','no-exit')) {
        $target=Join-Path $root ($case+'.ps1')
        if($case -ne 'missing') {
            $body=switch($case){'success'{'exit 0'} 'failure'{'exit 1'} 'throw'{"throw 'synthetic failure'"} 'no-exit'{"'fixture output' | Out-Null"}}
            [IO.File]::WriteAllText($target,$body)
        }
        $wrapper=Join-Path $root ('wrapper-'+$case+'.ps1')
        [IO.File]::WriteAllText($wrapper,$template.Replace("& '$candidate'",("& '"+$target.Replace("'","''")+"'")))
        & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $wrapper *> $null
        $expected=if($case -eq 'success'){0}else{1}
        if($LASTEXITCODE -ne $expected){throw ('Wrapper exit test failed: '+$case)}
        $count++
    }
    # Baseline reproduction: the former two-line wrapper misses invocation errors.
    $old=Join-Path $root 'old.ps1'
    [IO.File]::WriteAllText($old, ("& '"+(Join-Path $root 'missing.ps1')+"'`r`nexit `$LASTEXITCODE"))
    $ErrorActionPreference='Continue'
    & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $old *> $null
    $ErrorActionPreference='Stop'
    if($LASTEXITCODE -ne 0){throw 'Baseline reproduction changed'}
    $count++
    # Check the real candidate entry point maps a healthy policy outcome to 0.
    # Replace only its final entry-point policy call; no live imports or recovery.
    $source=[IO.File]::ReadAllText((Join-Path $repo 'scripts\chatbot-watchdog.ps1'))
    $entry=$source.Substring($source.LastIndexOf("if (`$MyInvocation.InvocationName -ne '.')"))
    $call='Invoke-ChatbotWatchdog $StartupTimeoutSeconds $PollIntervalSeconds $HttpTimeoutSeconds'
    if(-not $entry.Contains($call)){throw 'Candidate entry point changed'}
    $healthy=Join-Path $root 'healthy.ps1'
    [IO.File]::WriteAllText($healthy,$entry.Replace($call,"[pscustomobject]@{State='healthy';Reason='health-healthy';RecoveryAttempted=`$false}"))
    $wrapper=Join-Path $root 'wrapper-healthy.ps1'
    [IO.File]::WriteAllText($wrapper,$template.Replace("& '$candidate'",("& '"+$healthy+"'")))
    & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $wrapper *> $null
    if($LASTEXITCODE -ne 0){throw 'Healthy candidate outcome was not successful'}
    $count++
    Write-Output "PASS: $count isolated wrapper subprocess checks; no live candidate executed."
} finally {
    # Exact owned directory, no recursive removal or traversal into other paths.
    Get-ChildItem -LiteralPath $root -File | Remove-Item -Force
    [IO.Directory]::Delete($root,$false)
}
