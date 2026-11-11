# Dot-sourcing defines functions only; diagnostic execution is always explicit.
. (Join-Path $PSScriptRoot 'chatbot-owned-backend.ps1')
. (Join-Path $PSScriptRoot 'chatbot-backend-evidence.ps1')

function Test-ChatbotLiveBackendOwnership {
    [CmdletBinding()]
    param()
    $ErrorActionPreference = 'Stop'
    $backendName = 'AI Chatbot - llama.cpp'
    $expectedExe = 'C:\Users\Admin\Downloads\Chatbot-upgrade-17E2-20261015\llama-b11609-cuda12.4\llama-server.exe'
    $launcherScript = 'C:\AI\scripts\start-chatbot-ai.ps1'
    $powershellExe = Join-Path $PSHOME 'powershell.exe'
    $result = [pscustomobject]@{ OwnershipVerified=$false; ConfigurationMatched=$false; BackendPid=$null; Reason='evidence-unavailable' }
    try {
        $first = Read-OwnershipEvidence
        $second = Read-OwnershipEvidence
        foreach ($evidence in @($first, $second)) {
            if (-not (Test-ChatbotBackendOwnershipEvidence $evidence $expectedExe $launcherScript $powershellExe '127.0.0.1' 8080 'C:\AI\models')) {
                $result.Reason = 'ownership-unverified'; return $result
            }
        }
        # Full evidence equality includes both creation identities, arguments,
        # parent relation and the sole listener. No cached PID is authoritative.
        if (($first | ConvertTo-Json -Depth 5 -Compress) -cne ($second | ConvertTo-Json -Depth 5 -Compress)) {
            $result.Reason = 'ownership-changed'; return $result
        }
        $configText = Get-Content -LiteralPath 'C:\AI\config\chatbot-ai-config.json' -Raw -ErrorAction Stop
        $config = $configText | ConvertFrom-Json
        $expected = Get-ExpectedBackendArguments $config -NoDeviceProbe
        $matched = Test-ChatbotBackendEvidence $second $expectedExe $launcherScript $powershellExe '127.0.0.1' 8080 $expected
        $final = Read-OwnershipEvidence
        if (($second | ConvertTo-Json -Depth 5 -Compress) -cne ($final | ConvertTo-Json -Depth 5 -Compress)) {
            $result.Reason = 'ownership-changed'; return $result
        }
        if ($configText -cne (Get-Content -LiteralPath 'C:\AI\config\chatbot-ai-config.json' -Raw -ErrorAction Stop)) {
            $result.Reason = 'configuration-changed'; return $result
        }
        $result.OwnershipVerified = $true
        $result.ConfigurationMatched = [bool]$matched
        $result.BackendPid = $second.Backend.Pid
        $result.Reason = if ($matched) { 'verified' } else { 'configuration-mismatch' }
        return $result
    } catch {
        # Never return exceptions, command lines, configuration or key material.
        return $result
    }
}
