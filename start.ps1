$ErrorActionPreference = "Stop"
$toolDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if ($nodeCommand) {
    $nodeExecutable = $nodeCommand.Source
} else {
    $nodeExecutable = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}

if (-not (Test-Path -LiteralPath $nodeExecutable)) {
    Write-Host "Node.js was not found. Install Node.js and try again." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Set-Location -LiteralPath $toolDirectory
$env:OPEN_BROWSER = "1"
& $nodeExecutable (Join-Path $toolDirectory "server.js")
