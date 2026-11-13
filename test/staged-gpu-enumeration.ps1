param([Parameter(Mandatory=$true)][string]$Release)
$ErrorActionPreference='Stop'
$checks=0
foreach($name in @('chatbot-backend-evidence.ps1','start-chatbot-ai.ps1')) {
    $source=[IO.File]::ReadAllText((Join-Path $Release $name))
    $errors=$null
    [void][Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$errors)
    if($errors){throw 'Staged parsing failed'}
    $match=[regex]::Match($source,'(?ms)^\s*\$enumerationRuntime = .*?finally \{ Pop-Location -ErrorAction Stop \}')
    if(-not $match.Success){throw 'Staged enumeration guard missing'}
    # Replace only the native call with an injected fake. No executable is run.
    $block=$match.Value.Replace('& $enumerationExecutable --list-devices 2>&1','Invoke-TestEnumeration $enumerationExecutable --list-devices')
    if($block -eq $match.Value){throw 'Injection failed'}
    function Get-Item { param($LiteralPath,$ErrorAction)
        if($script:mode -eq 'missing'){throw 'Fixture missing'}
        [pscustomobject]@{PSIsContainer=($LiteralPath -notlike '*.exe');Attributes=$(if($script:mode -eq 'reparse'){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Normal})}
    }
    function Push-Location {param($LiteralPath,$ErrorAction)
        if($script:mode -eq 'push-failure'){throw 'Fixture push failure'}
        if($LiteralPath -ne 'C:\Protected\runtime'){throw 'Wrong runtime'}
        $script:location=$LiteralPath;$script:pushes++
    }
    function Pop-Location {param($ErrorAction) $script:location='inherited';$script:pops++}
    function Invoke-TestEnumeration {param($Executable,$Argument)
        if($script:location -ne 'C:\Protected\runtime' -or $Executable -ne 'C:\Protected\runtime\llama-server.exe' -or $Argument -ne '--list-devices'){throw 'Unsafe invocation'}
        $script:calls++
        if($script:mode -eq 'invoke-failure'){throw 'Fixture invocation failed'}
        $global:LASTEXITCODE=if($script:mode -eq 'exit-failure'){7}else{0}
        'CUDA0: fixture'
    }
    foreach($mode in @('success','missing','invalid-exe','relative-exe','reparse','push-failure','invoke-failure','exit-failure')) {
        $script:mode=$mode;$script:calls=0;$script:pops=0;$script:pushes=0;$script:location='inherited'
        $ServerExe=$expectedExe='C:\Protected\runtime\llama-server.exe'
        if($mode -eq 'invalid-exe'){$ServerExe=$expectedExe='C:\Other\llama-server.exe'}
        if($mode -eq 'relative-exe'){$ServerExe=$expectedExe='llama-server.exe'}
        $failed=$false
        try { & ([scriptblock]::Create($block)) } catch {$failed=$true}
        if($failed -ne ($mode -ne 'success')){throw "Incorrect outcome: $name $mode"}
        $expectedCalls=if($mode -in @('success','invoke-failure','exit-failure')){1}else{0}
        if($script:calls -ne $expectedCalls -or $script:pops -ne $script:pushes -or $script:location -ne 'inherited'){throw 'Invocation or restoration mismatch'}
        $checks++
    }
}
"PASS: $checks staged enumeration cases; native calls mocked."
