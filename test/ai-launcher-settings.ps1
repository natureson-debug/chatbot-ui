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
$Model='fixture.gguf'; $HostIP='127.0.0.1'; $Port=8080; $ApiKeyFile='fixture-key-path'; $WebOrigin='http://127.0.0.1:8080'; $Parallel=1; $ContextSize=32768
$count=0
foreach ($json in @('{}','{"gpuLayers":45,"device":"CUDA0","verbosity":4}','{"gpuLayers":0,"verbosity":0}','{"gpuLayers":999,"verbosity":5}')) {
    $AiConfig = ConvertFrom-Json $json
    . $validation
    . ([scriptblock]::Create($arguments.Extent.Text))
    $expectedLayers = if ($null -eq $AiConfig.gpuLayers) {37} else {$AiConfig.gpuLayers}
    if ($ServerArgs[$ServerArgs.IndexOf('--n-gpu-layers')+1] -cne "$expectedLayers" -or $ServerArgs[$ServerArgs.IndexOf('--device')+1] -cne 'CUDA0' -or $ServerArgs[$ServerArgs.IndexOf('--verbosity')+1] -cne "$Verbosity") { throw 'Wrong arguments' }
    $count++
}
foreach ($json in @('{"gpuLayers":-1}','{"gpuLayers":1000}','{"gpuLayers":1.5}','{"gpuLayers":"45"}','{"gpuLayers":null}','{"gpuLayers":true}','{"device":"CUDA1"}','{"device":"cuda0"}','{"device":"CUDA0 --host x"}','{"verbosity":6}','{"verbosity":"4"}','{"verbosity":null}')) {
    $AiConfig=ConvertFrom-Json $json; $rejected=$false
    try { . $validation } catch { $rejected=$true }
    if (-not $rejected) { throw "Malformed fixture accepted: $json" }
    $count++
}
Write-Output "PASS: PowerShell parse and $count isolated launcher validation/argument cases; launcher never executed."
