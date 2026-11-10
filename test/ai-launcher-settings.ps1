$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('C:\AI\scripts\start-chatbot-ai.ps1', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Execute only the configuration-validation fragment and argument-array AST.
# No launcher checks, secret reads, logging, networking or process invocation.
$text = $ast.Extent.Text
$begin = $text.IndexOf('# Missing properties retain')
$end = $text.IndexOf('$Model       =', $begin)
if ($begin -lt 0 -or $end -lt 0) { throw 'Missing test fragment' }
$validation = [scriptblock]::Create($text.Substring($begin, $end - $begin))
$arguments = $ast.Find({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$ServerArgs'}, $true)
if ($null -eq $arguments) { throw 'Missing argument assignment' }
$argumentEnd = $text.IndexOf('Write-Host "Starting llama-server..."', $arguments.Extent.StartOffset)
if ($argumentEnd -lt 0) { throw 'Missing launcher invocation boundary' }
$argumentBlock = [scriptblock]::Create($text.Substring($arguments.Extent.StartOffset, $argumentEnd - $arguments.Extent.StartOffset))
$Model='fixture.gguf'; $HostIP='127.0.0.1'; $Port=8080; $ApiKeyFile='fixture-key-path'; $WebOrigin='http://127.0.0.1:8080'; $Parallel=1; $ContextSize=32768
$AvailableGpuDevices=@('CUDA0','CUDA1')
$count=0
foreach ($json in @('{}','{"gpuLayers":45,"device":"CUDA0","verbosity":4}','{"gpuLayers":0,"verbosity":0}','{"gpuLayers":999,"verbosity":5}')) {
    $AiConfig = ConvertFrom-Json $json
    . $validation
    . $argumentBlock
    $expectedLayers = if ($null -eq $AiConfig.gpuLayers) {37} else {$AiConfig.gpuLayers}
    if ($ServerArgs[$ServerArgs.IndexOf('--n-gpu-layers')+1] -cne "$expectedLayers" -or $ServerArgs[$ServerArgs.IndexOf('--device')+1] -cne 'CUDA0' -or $ServerArgs[$ServerArgs.IndexOf('--verbosity')+1] -cne "$Verbosity" -or $ServerArgs -contains '--split-mode' -or $ServerArgs -contains '--tensor-split') { throw "Wrong single-GPU arguments: $($ServerArgs -join '|')" }
    $count++
}
foreach ($json in @('{"device":"CUDA0,CUDA1","splitMode":"layer","tensorSplit":"3,2"}','{"device":"CUDA0,CUDA1","splitMode":"row"}')) {
    $AiConfig=ConvertFrom-Json $json; . $validation
    . $argumentBlock
    if ($ServerArgs[$ServerArgs.IndexOf('--device')+1] -cne 'CUDA0,CUDA1' -or
        $ServerArgs[$ServerArgs.IndexOf('--split-mode')+1] -cne $AiConfig.splitMode) { throw 'Wrong multi-GPU arguments' }
    if ($AiConfig.tensorSplit -and $ServerArgs[$ServerArgs.IndexOf('--tensor-split')+1] -cne '3,2') { throw 'Wrong tensor-split arguments' }
    if (-not $AiConfig.tensorSplit -and $ServerArgs -contains '--tensor-split') { throw 'Unexpected tensor-split argument' }
    $count++
}
foreach ($json in @('{"gpuLayers":-1}','{"gpuLayers":1000}','{"gpuLayers":1.5}','{"gpuLayers":"45"}','{"gpuLayers":null}','{"gpuLayers":true}','{"device":"CUDA2"}','{"device":"CUDA0,CUDA0"}','{"device":"CUDA0 --host x"}','{"splitMode":"invalid"}','{"device":"CUDA0,CUDA1","tensorSplit":"3"}','{"device":"CUDA0,CUDA1","tensorSplit":"3,0"}','{"device":"CUDA0","tensorSplit":"1,2"}','{"verbosity":6}','{"verbosity":"4"}','{"verbosity":null}')) {
    $AiConfig=ConvertFrom-Json $json; $rejected=$false
    try { . $validation } catch { $rejected=$true }
    if (-not $rejected) { throw "Malformed fixture accepted: $json" }
    $count++
}
Write-Output "PASS: PowerShell parse and $count isolated launcher validation/argument cases; launcher never executed."
