param([switch]$InitializeNew)
$ErrorActionPreference = 'Stop'
try {
    $node = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'nodejs\node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Install Node.js 24 x64 in Program Files\nodejs first.' }
    # Never inherit Node preload modules into this launcher.
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    & $node -e "process.exit(process.platform==='win32' && process.arch==='x64' && process.versions.node.split('.')[0]==='24' ? 0 : 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 24 x64 is required.' }
    $root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AIChatbot'
    $env:CHATBOT_HOME = $root
    $env:CHATBOT_DATA_ROOT = $root
    $env:CHATBOT_STORAGE_MODE = 'per-user'
    $env:CHATBOT_DB_PATH = Join-Path $root 'data\chatbot.db'
    $env:CHATBOT_PORT = '3000'
    Set-Location -LiteralPath $PSScriptRoot
    if ($InitializeNew) {
        if (Test-Path -LiteralPath $root) { throw 'Application data already exists. Initialization refused; do not use initialization as recovery.' }
        New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $root 'data'), (Join-Path $root 'config') | Out-Null
        & $node (Join-Path $PSScriptRoot 'scripts\initialize-database.cjs') --create-new-database
        if ($LASTEXITCODE -ne 0) { throw 'Database initialization failed. Preserve the directory for review; do not retry over it.' }
        $env:CHATBOT_ADMIN_USERNAME = Read-Host 'New administrator username'
        $secure = Read-Host 'New administrator password' -AsSecureString
        $credential = New-Object System.Management.Automation.PSCredential('setup', $secure)
        try {
            $env:CHATBOT_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
            & $node (Join-Path $PSScriptRoot 'setup-admin.js')
            if ($LASTEXITCODE -ne 0) { throw 'Administrator setup failed. Review first-run recovery; no server was started.' }
        } finally {
            Remove-Item Env:CHATBOT_ADMIN_PASSWORD -ErrorAction SilentlyContinue
            Remove-Item Env:CHATBOT_ADMIN_USERNAME -ErrorAction SilentlyContinue
            $credential = $null
            if ($null -ne $secure) { $secure.Dispose() }
        }
        Write-Host 'Initialization complete. Read FIRST-RUN.txt for HTTPS and provider setup. No backend was started.'
    } else {
        if (-not (Test-Path -LiteralPath $env:CHATBOT_DB_PATH -PathType Leaf)) { throw 'Existing database missing. Read FIRST-RUN.txt; normal launch never creates a database.' }
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue)
        if ($listeners.Count -gt 0) { throw 'Port 3000 is occupied. No process will be stopped or adopted.' }
        Write-Host 'Starting AIChatbot on 127.0.0.1:3000. Keep this console open; use Ctrl+C for graceful shutdown.'
        & $node (Join-Path $PSScriptRoot 'server.js')
        if ($LASTEXITCODE -ne 0) { throw 'AIChatbot exited unsuccessfully. Review its console diagnostics.' }
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close' | Out-Null
    exit 1
}
