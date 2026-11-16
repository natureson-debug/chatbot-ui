# ============================================================
# LAN AI Chatbot - llama.cpp
# Hardened startup script
# ============================================================

$ErrorActionPreference = "Stop"

# ------------------------------------------------------------
# Configuration
# ------------------------------------------------------------

$LlamaDir   = "C:\Users\Admin\Downloads\Chatbot-upgrade-17E2-20261015\llama-b11609-cuda12.4"
$ServerExe  = Join-Path $LlamaDir "llama-server.exe"

$ConfigFile = "C:\AI\config\chatbot-ai-config.json"
$ModelsDir  = "C:\AI\models"

if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
    throw "AI configuration file not found: $ConfigFile"
}

try {
    $AiConfig = Get-Content -LiteralPath $ConfigFile -Raw |
        ConvertFrom-Json
}
catch {
    throw "Failed to read AI configuration: $($_.Exception.Message)"
}

function Get-AvailableGpuDevices {
    $output = @(& $ServerExe --list-devices 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to discover GPU devices using llama.cpp --list-devices."
    }

    $devices = [Collections.Generic.List[string]]::new()
    foreach ($line in $output) {
        $match = [regex]::Match([string]$line, '^\s*(CUDA\d+):\s+.+?(?:\s+\([\d,]+\s+MiB,\s+[\d,]+\s+MiB free\))?\s*$')
        if ($match.Success -and -not $devices.Contains($match.Groups[1].Value)) {
            $devices.Add($match.Groups[1].Value)
        }
    }
    if ($devices.Count -eq 0) {
        throw "llama.cpp did not report any available NVIDIA CUDA devices."
    }
    return $devices.ToArray()
}

$AvailableGpuDevices = @(Get-AvailableGpuDevices)

# Missing properties retain the previously hard-coded launch behavior.
function Get-LaunchInteger($Name, $Default, $Maximum) {
    $Property = $AiConfig.PSObject.Properties[$Name]
    if ($null -eq $Property) { return $Default }
    $Value = $Property.Value
    if (($Value -isnot [int] -and $Value -isnot [long] -and $Value -isnot [double] -and $Value -isnot [decimal]) -or
        [double]::IsNaN([double]$Value) -or [double]::IsInfinity([double]$Value) -or
        $Value -lt 0 -or $Value -gt $Maximum -or [math]::Truncate([double]$Value) -ne $Value) {
        throw "Invalid $Name; expected integer from 0 to $Maximum"
    }
    return [int]$Value
}
$GpuLayers = Get-LaunchInteger 'gpuLayers' 37 999
$Verbosity = Get-LaunchInteger 'verbosity' 4 5
$Device = 'CUDA0'
if ($null -ne $AiConfig.PSObject.Properties['device']) {
    if ($AiConfig.device -isnot [string]) { throw 'GPU devices must be a comma-separated device list.' }
    $Device = $AiConfig.device
}
$ConfiguredDevices = @($Device.Split(',') | ForEach-Object { $_.Trim() })
if ($ConfiguredDevices.Count -eq 0 -or
    $ConfiguredDevices | Where-Object { $_ -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$' }) {
    throw 'GPU devices must be valid device IDs from llama.cpp.'
}
$DeviceMap = @{}
foreach ($AvailableDevice in $AvailableGpuDevices) { $DeviceMap[$AvailableDevice] = $AvailableDevice }
$SelectedDevices = [Collections.Generic.List[string]]::new()
$SelectedDeviceSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($SelectedDevice in $ConfiguredDevices) {
    if (-not $SelectedDeviceSet.Add($SelectedDevice)) { throw 'A GPU device cannot be selected more than once.' }
    if (-not $DeviceMap.ContainsKey($SelectedDevice)) { throw "GPU device $SelectedDevice is not available." }
    $SelectedDevices.Add($DeviceMap[$SelectedDevice])
}
$Device = $SelectedDevices -join ','

$SplitMode = 'layer'
if ($null -ne $AiConfig.PSObject.Properties['splitMode'] -and $null -ne $AiConfig.splitMode) {
    if ($AiConfig.splitMode -isnot [string]) { throw 'Split mode must be none, layer, row, or tensor.' }
    $SplitMode = $AiConfig.splitMode
}
if ($SplitMode -cnotin @('none', 'layer', 'row', 'tensor')) {
    throw 'Split mode must be none, layer, row, or tensor.'
}

$TensorSplit = $null
if ($null -ne $AiConfig.PSObject.Properties['tensorSplit'] -and $null -ne $AiConfig.tensorSplit) {
    if ($AiConfig.tensorSplit -isnot [string]) {
        throw 'Tensor split must be comma-separated positive numbers.'
    }
    $TensorParts = $AiConfig.tensorSplit.Trim().Split(',')
    if ($AiConfig.tensorSplit.Trim() -eq '') {
        $TensorParts = @()
    } else {
        $TensorParts = @($TensorParts | ForEach-Object { $_.Trim() })
        if ($TensorParts.Count -ne $SelectedDevices.Count) {
            throw 'Tensor split must contain one proportion for each selected GPU.'
        }
        foreach ($TensorPart in $TensorParts) {
            $Proportion = 0.0
            if ($TensorPart -notmatch '^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$' -or
                -not [double]::TryParse($TensorPart, [Globalization.NumberStyles]::Float,
                    [Globalization.CultureInfo]::InvariantCulture, [ref]$Proportion) -or
                [double]::IsInfinity($Proportion) -or [double]::IsNaN($Proportion) -or $Proportion -le 0) {
                throw 'Tensor split must contain only positive numeric proportions.'
            }
        }
        if ($SelectedDevices.Count -lt 2) { throw 'Tensor split requires at least two selected GPUs.' }
        $TensorSplit = $TensorParts -join ','
    }
}

$Metrics = $false
if ($null -ne $AiConfig.PSObject.Properties['metrics']) {
    if ($AiConfig.metrics -isnot [bool]) { throw 'Invalid metrics flag; expected boolean' }
    $Metrics = [bool]$AiConfig.metrics
}

$Model       = Join-Path $ModelsDir $AiConfig.model
$Parallel    = [int]$AiConfig.parallel
$ContextSize = [int]$AiConfig.contextSize

$ApiKeyFile = "C:\AI\config\llama-api-key.txt"

$HostIP     = "127.0.0.1"
$Port       = 8080

$WebOrigin  = "http://$($HostIP):$Port"

$LogDir     = "C:\AI\logs"
$LogFile    = Join-Path $LogDir "llama-server.log"
$StartupLog = Join-Path $LogDir "startup.log"

# ------------------------------------------------------------
# Create log directory
# ------------------------------------------------------------

if (-not (Test-Path -LiteralPath $LogDir -PathType Container)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# ------------------------------------------------------------
# Logging helper
# ------------------------------------------------------------

function Write-StartupLog {
    param (
        [string]$Message
    )

    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $StartupLog `
        -Value "$Timestamp  $Message"
}

# ------------------------------------------------------------
# Failure helper
# ------------------------------------------------------------

function Fail {
    param (
        [string]$Message
    )

    Write-StartupLog "ERROR: $Message"

    Write-Host ""
    Write-Host "ERROR: $Message" -ForegroundColor Red
    Write-Host ""

    exit 1
}

# ------------------------------------------------------------
# Required file validation
# ------------------------------------------------------------

function Test-RequiredFile {
    param (
        [string]$Path,
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail "$Description not found: $Path"
    }
}

# ------------------------------------------------------------
# Startup marker
# ------------------------------------------------------------

Write-StartupLog "============================================================"
Write-StartupLog "LAN AI Chatbot startup initiated."
Write-StartupLog "Host: $HostIP"
Write-StartupLog "Port: $Port"
Write-StartupLog "Model: $Model"

# ------------------------------------------------------------
# Validate directories/files
# ------------------------------------------------------------

if (-not (Test-Path -LiteralPath $LlamaDir -PathType Container)) {
    Fail "llama.cpp directory not found: $LlamaDir"
}

Test-RequiredFile $ServerExe "llama-server executable"
Test-RequiredFile $Model "Model"
Test-RequiredFile $ApiKeyFile "API key file"

Write-StartupLog "Required files validated."

# ------------------------------------------------------------
# Read API key
# ------------------------------------------------------------

$ApiKey = (Get-Content -LiteralPath $ApiKeyFile -Raw).Trim()

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Fail "API key file is empty."
}

# Never write $ApiKey to any log.
Write-StartupLog "API key file validated."

# ------------------------------------------------------------
# Verify API key file permissions
# ------------------------------------------------------------

$Acl = Get-Acl -LiteralPath $ApiKeyFile

$UnexpectedAccess = $Acl.Access | Where-Object {
    $_.IdentityReference -notmatch "^(NT AUTHORITY\\SYSTEM|.*\\Admin)$"
}

if ($UnexpectedAccess) {

    Write-StartupLog "WARNING: API key file has additional ACL entries."

    Write-Host ""
    Write-Host "WARNING: API key file has additional ACL entries." `
        -ForegroundColor Yellow

    Write-Host "Review with:"
    Write-Host "icacls $ApiKeyFile"
    Write-Host ""
}

# ------------------------------------------------------------
# Check listening port
# ------------------------------------------------------------

$ExistingListener = Get-NetTCPConnection `
    -LocalPort $Port `
    -State Listen `
    -ErrorAction SilentlyContinue

if ($ExistingListener) {

    Write-StartupLog "ERROR: TCP port $Port is already listening."

    Write-Host ""
    Write-Host "ERROR: TCP port $Port is already listening." `
        -ForegroundColor Red
    Write-Host ""

    $ExistingListener |
        Select-Object LocalAddress,LocalPort,OwningProcess |
        Format-Table -AutoSize

    Write-Host ""
    Write-Host "Check the owning process with:"
    Write-Host "Get-Process -Id <PID>"
    Write-Host ""

    exit 1
}

# ------------------------------------------------------------
# Verify requested IP address exists
# ------------------------------------------------------------

$IPAddress = Get-NetIPAddress `
    -IPAddress $HostIP `
    -ErrorAction SilentlyContinue

if (-not $IPAddress) {
    Fail "IP address $HostIP is not configured on this computer."
}

Write-StartupLog "Network address validation successful."

# ------------------------------------------------------------
# Startup information
# ------------------------------------------------------------

Write-Host ""
Write-Host "============================================================"
Write-Host " LAN AI CHATBOT"
Write-Host "============================================================"
Write-Host "llama.cpp : $LlamaDir"
Write-Host "Model     : $Model"
Write-Host "Host      : $HostIP"
Write-Host "Port      : $Port"
Write-Host "Web UI    : $WebOrigin"
Write-Host "CORS      : $WebOrigin"
Write-Host "Auth      : API key"
Write-Host "Log       : $LogFile"
Write-Host "============================================================"
Write-Host ""

Write-Host "Validation successful." -ForegroundColor Green
Write-Host "Starting llama-server..."
Write-Host ""

Write-StartupLog "Validation successful."
Write-StartupLog "Starting llama-server."

# ------------------------------------------------------------
# Start llama-server
# ------------------------------------------------------------

$ServerArgs = @(
    "--model", $Model
    "--host", $HostIP
    "--port", $Port
    "--api-key-file", $ApiKeyFile
    "--cors-origins", $WebOrigin
    "--parallel", "$Parallel"
    "--ctx-size", "$ContextSize"
    "--device", $Device
)

if ($SelectedDevices.Count -gt 1) {
    $ServerArgs += "--split-mode", $SplitMode
    if ($null -ne $TensorSplit) { $ServerArgs += "--tensor-split", $TensorSplit }
}

$ServerArgs += "--n-gpu-layers", "$GpuLayers", "--verbosity", "$Verbosity"

if ($Metrics) {
    $ServerArgs += "--metrics"
}

Write-Host "Starting llama-server..."
Write-Host "Parallel slots : $Parallel"
Write-Host "Context size   : $ContextSize"
Write-Host "Metrics        : $Metrics"
Write-Host ""

Set-Location -LiteralPath $LlamaDir

& $ServerExe @ServerArgs

# ------------------------------------------------------------
# Server exited
# ------------------------------------------------------------

$ExitCode = $LASTEXITCODE

Write-Host ""
Write-Host "============================================================"
Write-Host "llama-server exited."
Write-Host "Exit code: $ExitCode"
Write-Host "Log file : $LogFile"
Write-Host "============================================================"
Write-Host ""
