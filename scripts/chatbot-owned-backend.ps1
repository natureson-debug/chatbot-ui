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
        $expectedPath = Get-ChatbotNormalizedPath $ExpectedExecutable
        if ($null -eq $backendArguments -or $backendArguments.Count -ne $ExpectedArguments.Count -or
            (Get-ChatbotNormalizedPath $backendArguments[0]) -cne $expectedPath) { return $false }
        for ($i = 1; $i -lt $ExpectedArguments.Count; $i++) {
            if (-not [string]::Equals($backendArguments[$i], $ExpectedArguments[$i], [StringComparison]::OrdinalIgnoreCase)) {
                return $false
            }
        }

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

function Invoke-ChatbotOwnedBackendStop {
    param(
        [Parameter(Mandatory)][scriptblock]$Observe,
        [Parameter(Mandatory)][scriptblock]$Terminate,
        [Parameter(Mandatory)][string]$ExpectedExecutable,
        [Parameter(Mandatory)][string]$LauncherScript,
        [Parameter(Mandatory)][string]$PowerShellExecutable,
        [Parameter(Mandatory)][string]$BindAddress,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string[]]$ExpectedArguments
    )

    try {
        $first = & $Observe
        if (-not (Test-ChatbotBackendEvidence $first $ExpectedExecutable $LauncherScript $PowerShellExecutable $BindAddress $Port $ExpectedArguments)) {
            return [pscustomobject]@{ Stopped = $false; Reason = 'ownership-unverified' }
        }
        $second = & $Observe
        if (-not (Test-ChatbotBackendEvidence $second $ExpectedExecutable $LauncherScript $PowerShellExecutable $BindAddress $Port $ExpectedArguments) -or
            $first.Backend.Pid -ne $second.Backend.Pid -or
            $first.Backend.CreatedAt -cne $second.Backend.CreatedAt -or
            $first.Parent.Pid -ne $second.Parent.Pid -or
            $first.Parent.CreatedAt -cne $second.Parent.CreatedAt) {
            return [pscustomobject]@{ Stopped = $false; Reason = 'ownership-changed' }
        }
        & $Terminate ([int]$second.Backend.Pid)
        return [pscustomobject]@{ Stopped = $true; Reason = 'verified-owner'; Pid = [int]$second.Backend.Pid }
    } catch {
        return [pscustomobject]@{ Stopped = $false; Reason = 'ownership-unverified' }
    }
}
