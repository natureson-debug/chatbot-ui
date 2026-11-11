$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'restart-lifecycle-safety.ps1')

# Extract only the pure argument builder; replace device enumeration with fixture
# output. Never invoke Restart-ChatbotAI or a production executable/task.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot '..\scripts\Restart-ChatbotAI.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Restart script did not parse.' }
$builder = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ExpectedBackendArguments'
}, $true).Extent.Text
$enumeration = '& $expectedExe --list-devices 2>&1'
if (-not $builder.Contains($enumeration)) { throw 'Device enumeration fixture requires review.' }
$builder = $builder.Replace($enumeration, "'CUDA0: Fixture', 'CUDA1: Fixture'")
. ([scriptblock]::Create($builder))
$LASTEXITCODE = 0
$expectedExe = $exe
$config = [pscustomobject]@{ model='fixture.gguf'; parallel=1; contextSize=32768;
    device='CUDA0,CUDA1'; splitMode='layer'; tensorSplit=''; gpuLayers=45; verbosity=4; metrics=$true }
$target = Get-ExpectedBackendArguments $config
if ($target -contains '--tensor-split') { throw 'Empty tensorSplit must omit its flag.' }
$observed = New-Evidence
$observed.Backend.CommandLine = $observed.Backend.CommandLine.Replace('--tensor-split 3,2 ', '')
$observed.Parent.CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
$actual = ConvertFrom-ChatbotCommandLine $observed.Backend.CommandLine
if (($actual -join "`n") -cne ($target -join "`n")) { throw 'Expected argument construction differs from the launcher fixture.' }
if (-not (Test-ChatbotSafeBackendArguments $actual $exe $modelDirectory)) { throw 'Valid dual-GPU argument grammar failed.' }
if (-not (Test-ChatbotBackendEvidence $observed $exe $launcher $powershell '127.0.0.1' 8080 $target)) {
    throw 'Trusted bare PowerShell argv0 rejected despite verified executable path and matching arguments.'
}
$count = 1
foreach ($mutate in @(
    { param($o) $o.Backend.CommandLine = $o.Backend.CommandLine.Replace('CUDA0,CUDA1', 'CUDA0,CUDA2') },
    { param($o) $o.Backend.CommandLine = $o.Backend.CommandLine.Replace('--split-mode layer', '--split-mode row') },
    { param($o) $o.Backend.CommandLine = $o.Backend.CommandLine.Replace('--n-gpu-layers 45', '--n-gpu-layers 44') },
    { param($o) $o.Backend.CommandLine += ' --unknown' },
    { param($o) $o.Backend.Executable = 'C:\untrusted\llama-server.exe' },
    { param($o) $o.Parent.Executable = 'C:\untrusted\powershell.exe' },
    { param($o) $o.Parent.CommandLine = $o.Parent.CommandLine.Replace('powershell.exe', '.\powershell.exe') },
    { param($o) $o.Parent.CommandLine = $o.Parent.CommandLine.Replace($launcher, 'C:\untrusted\launch.ps1') },
    { param($o) $o.Parent.Pid = 91 },
    { param($o) $o.Parent.CreatedAt = '2026-11-10T10:00:02.0000000Z' },
    { param($o) $o.TaskActionVerified = $false },
    { param($o) $o.Listeners += $o.Listeners[0] }
)) {
    $copy = $observed | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    & $mutate $copy
    if (Test-ChatbotBackendEvidence $copy $exe $launcher $powershell '127.0.0.1' 8080 $target) {
        throw 'Invalid post-start observation was accepted.'
    }
    $count++
}
Write-Output "PASS: $count post-start acceptance/refusal cases; empty tensorSplit builder matches launcher."
