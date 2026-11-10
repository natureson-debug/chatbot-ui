# These helpers validate two independent process observations before a caller
# may act on the exact listener-owning PID. They never discover or terminate by name.
function ConvertFrom-ChatbotCommandLine {
    param([Parameter(Mandatory)][string]$CommandLine)
    if ($CommandLine -match '[\x00\r\n]') { return $null }

    $values = [Collections.Generic.List[string]]::new()
    $index = 0
    while ($index -lt $CommandLine.Length) {
        while ($index -lt $CommandLine.Length -and [char]::IsWhiteSpace($CommandLine[$index])) { $index++ }
        if ($index -eq $CommandLine.Length) { break }
        $value = [Text.StringBuilder]::new()
        $quoted = $false
        while ($index -lt $CommandLine.Length -and ($quoted -or -not [char]::IsWhiteSpace($CommandLine[$index]))) {
            $slashes = 0
            while ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '\') { $slashes++; $index++ }
            if ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '"') {
                [void]$value.Append(('\' * [int][Math]::Floor($slashes / 2)))
                if ($slashes % 2) {
                    [void]$value.Append('"')
                } elseif ($quoted -and $index + 1 -lt $CommandLine.Length -and $CommandLine[$index + 1] -eq '"') {
                    [void]$value.Append('"')
                    $index++
                } else {
                    $quoted = -not $quoted
                }
                $index++
            } else {
                [void]$value.Append(('\' * $slashes))
                if ($index -lt $CommandLine.Length -and ($quoted -or -not [char]::IsWhiteSpace($CommandLine[$index]))) {
                    [void]$value.Append($CommandLine[$index])
                    $index++
                }
            }
        }
        if ($quoted) { return $null }
        $values.Add($value.ToString())
    }
    return ,$values.ToArray()
}

function Get-ChatbotNormalizedPath {
    param([object]$Value)
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { return $null }
    try { return [IO.Path]::GetFullPath($Value).TrimEnd('\').ToLowerInvariant() }
    catch { return $Value.Replace('/', '\').TrimEnd('\').ToLowerInvariant() }
}

function Test-ChatbotSafeBackendArguments {
    param(
        [string[]]$Arguments,
        [string]$ExpectedExecutable,
        [string]$ModelDirectory
    )
    if ($null -eq $Arguments -or $Arguments.Count -lt 21 -or
        (Get-ChatbotNormalizedPath $Arguments[0]) -cne (Get-ChatbotNormalizedPath $ExpectedExecutable)) { return $false }

    $modelDirectoryPath = (Get-ChatbotNormalizedPath $ModelDirectory) + '\'
    $modelPath = Get-ChatbotNormalizedPath $Arguments[2]
    if ($Arguments[1] -cne '--model' -or
        $null -eq $modelPath -or -not $modelPath.StartsWith($modelDirectoryPath, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-ChatbotNormalizedPath ([IO.Path]::GetDirectoryName($modelPath))) -cne (Get-ChatbotNormalizedPath $ModelDirectory) -or
        [IO.Path]::GetExtension($modelPath) -ine '.gguf' -or
        $Arguments[3] -cne '--host' -or $Arguments[4] -cne '127.0.0.1' -or
        $Arguments[5] -cne '--port' -or $Arguments[6] -cne '8080' -or
        $Arguments[7] -cne '--api-key-file' -or
        (Get-ChatbotNormalizedPath $Arguments[8]) -cne 'c:\ai\config\llama-api-key.txt' -or
        $Arguments[9] -cne '--cors-origins' -or $Arguments[10] -cne 'http://127.0.0.1:8080' -or
        $Arguments[11] -cne '--parallel' -or $Arguments[12] -notmatch '^[1-8]$' -or
        $Arguments[13] -cne '--ctx-size' -or $Arguments[14] -notmatch '^\d+$' -or
        [int]$Arguments[14] -lt 1024 -or [int]$Arguments[14] -gt 131072 -or [int]$Arguments[14] % 1024 -ne 0 -or
        $Arguments[15] -cne '--device') { return $false }

    $devices = @($Arguments[16].Split(','))
    if ($devices.Count -eq 0 -or
        @($devices | Where-Object { $_ -notmatch '^CUDA\d+$' }).Count -gt 0 -or
        @($devices | ForEach-Object { $_.ToUpperInvariant() } | Select-Object -Unique).Count -ne $devices.Count) { return $false }

    $index = 17
    if ($Arguments[$index] -ceq '--split-mode') {
        if ($devices.Count -lt 2 -or $index + 1 -ge $Arguments.Count -or
            $Arguments[$index + 1] -cnotin @('none', 'layer', 'row', 'tensor')) { return $false }
        $index += 2
    } elseif ($devices.Count -gt 1) {
        return $false
    }
    if ($index -lt $Arguments.Count -and $Arguments[$index] -ceq '--tensor-split') {
        if ($devices.Count -lt 2 -or $index + 1 -ge $Arguments.Count) { return $false }
        $proportions = @($Arguments[$index + 1].Split(','))
        if ($proportions.Count -ne $devices.Count) { return $false }
        foreach ($proportionText in $proportions) {
            $proportion = 0.0
            if ($proportionText -notmatch '^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$' -or
                -not [double]::TryParse($proportionText, [Globalization.NumberStyles]::Float,
                    [Globalization.CultureInfo]::InvariantCulture, [ref]$proportion) -or
                [double]::IsInfinity($proportion) -or [double]::IsNaN($proportion) -or $proportion -le 0) { return $false }
        }
        $index += 2
    }
    if ($index + 3 -ge $Arguments.Count -or
        $Arguments[$index] -cne '--n-gpu-layers' -or $Arguments[$index + 1] -notmatch '^(0|[1-9]\d{0,2})$' -or
        [int]$Arguments[$index + 1] -gt 999 -or
        $Arguments[$index + 2] -cne '--verbosity' -or $Arguments[$index + 3] -notmatch '^[0-5]$') { return $false }
    $index += 4
    if ($index -lt $Arguments.Count -and $Arguments[$index] -ceq '--metrics') { $index++ }
    return $index -eq $Arguments.Count
}

function Test-ChatbotBackendOwnershipEvidence {
    param(
        [object]$Evidence,
        [string]$ExpectedExecutable,
        [string]$LauncherScript,
        [string]$PowerShellExecutable,
        [string]$BindAddress,
        [int]$Port,
        [string]$ModelDirectory
    )
    try {
        if (!$Evidence -or $Evidence.TaskActionVerified -ne $true) { return $false }
        $backend = $Evidence.Backend
        $parent = $Evidence.Parent
        $listeners = @($Evidence.Listeners)
        if (!$backend -or !$parent -or $listeners.Count -ne 1 -or
            $backend.Pid -isnot [int] -or $backend.Pid -le 0 -or
            $parent.Pid -isnot [int] -or $parent.Pid -ne $backend.ParentPid -or
            $backend.CreatedAt -isnot [string] -or $parent.CreatedAt -isnot [string]) { return $false }
        if ((Get-ChatbotNormalizedPath $backend.Executable) -cne (Get-ChatbotNormalizedPath $ExpectedExecutable) -or
            (Get-ChatbotNormalizedPath $parent.Executable) -cne (Get-ChatbotNormalizedPath $PowerShellExecutable)) { return $false }
        $backendCreated = [datetimeoffset]::MinValue
        $parentCreated = [datetimeoffset]::MinValue
        if (![datetimeoffset]::TryParse($backend.CreatedAt, [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind, [ref]$backendCreated) -or
            ![datetimeoffset]::TryParse($parent.CreatedAt, [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind, [ref]$parentCreated) -or
            $parentCreated -gt $backendCreated) { return $false }

        $listener = $listeners[0]
        if ($listener.LocalAddress -cne $BindAddress -or [int]$listener.LocalPort -ne $Port -or
            [int]$listener.OwningProcess -ne $backend.Pid) { return $false }

        $backendArguments = ConvertFrom-ChatbotCommandLine $backend.CommandLine
        if (-not (Test-ChatbotSafeBackendArguments $backendArguments $ExpectedExecutable $ModelDirectory)) { return $false }

        $launcherArguments = ConvertFrom-ChatbotCommandLine $parent.CommandLine
        if ($null -eq $launcherArguments -or $launcherArguments.Count -ne 6 -or
            (Get-ChatbotNormalizedPath $launcherArguments[0]) -cne (Get-ChatbotNormalizedPath $PowerShellExecutable) -or
            $launcherArguments[1] -cne '-NoProfile' -or
            $launcherArguments[2] -cne '-ExecutionPolicy' -or
            $launcherArguments[3] -cne 'Bypass' -or
            $launcherArguments[4] -cne '-File' -or
            (Get-ChatbotNormalizedPath $launcherArguments[5]) -cne (Get-ChatbotNormalizedPath $LauncherScript)) { return $false }
        return $true
    } catch {
        return $false
    }
}

function Test-ChatbotBackendEvidence {
    param(
        [object]$Evidence,
        [string]$ExpectedExecutable,
        [string]$LauncherScript,
        [string]$PowerShellExecutable,
        [string]$BindAddress,
        [int]$Port,
        [string[]]$ExpectedArguments
    )
    if (-not (Test-ChatbotBackendOwnershipEvidence $Evidence $ExpectedExecutable $LauncherScript `
            $PowerShellExecutable $BindAddress $Port 'C:\AI\models')) { return $false }
    $backendArguments = ConvertFrom-ChatbotCommandLine $Evidence.Backend.CommandLine
    if ($null -eq $backendArguments -or $backendArguments.Count -ne $ExpectedArguments.Count) { return $false }
    for ($i = 0; $i -lt $ExpectedArguments.Count; $i++) {
        if ($i -eq 0) {
            if ((Get-ChatbotNormalizedPath $backendArguments[$i]) -cne (Get-ChatbotNormalizedPath $ExpectedArguments[$i])) { return $false }
        } elseif (-not [string]::Equals($backendArguments[$i], $ExpectedArguments[$i], [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }
    return $true
}

function Invoke-ChatbotOwnedBackendStop {
    param(
        [Parameter(Mandatory)][scriptblock]$Observe,
        [Parameter(Mandatory)][scriptblock]$Terminate,
        [Parameter(Mandatory)][string]$ExpectedExecutable,
        [Parameter(Mandatory)][string]$LauncherScript,
        [Parameter(Mandatory)][string]$PowerShellExecutable,
        [Parameter(Mandatory)][string]$BindAddress,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$ModelDirectory
    )

    try {
        $first = & $Observe
        if (-not (Test-ChatbotBackendOwnershipEvidence $first $ExpectedExecutable $LauncherScript `
                $PowerShellExecutable $BindAddress $Port $ModelDirectory)) {
            return [pscustomobject]@{ Stopped = $false; Reason = 'ownership-unverified' }
        }
        $second = & $Observe
        if (-not (Test-ChatbotBackendOwnershipEvidence $second $ExpectedExecutable $LauncherScript `
                $PowerShellExecutable $BindAddress $Port $ModelDirectory) -or
            $first.Backend.Pid -ne $second.Backend.Pid -or
            $first.Backend.CreatedAt -cne $second.Backend.CreatedAt -or
            $first.Parent.Pid -ne $second.Parent.Pid -or
            $first.Parent.CreatedAt -cne $second.Parent.CreatedAt -or
            $first.Backend.CommandLine -cne $second.Backend.CommandLine -or
            $first.Listeners[0].LocalAddress -cne $second.Listeners[0].LocalAddress -or
            [int]$first.Listeners[0].LocalPort -ne [int]$second.Listeners[0].LocalPort -or
            [int]$first.Listeners[0].OwningProcess -ne [int]$second.Listeners[0].OwningProcess) {
            return [pscustomobject]@{ Stopped = $false; Reason = 'ownership-changed' }
        }
        & $Terminate ([int]$second.Backend.Pid)
        return [pscustomobject]@{ Stopped = $true; Reason = 'verified-owner'; Pid = [int]$second.Backend.Pid }
    } catch {
        return [pscustomobject]@{ Stopped = $false; Reason = 'ownership-unverified' }
    }
}
