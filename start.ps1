$ErrorActionPreference = "Stop"
$toolDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if ($nodeCommand) {
    $nodeExecutable = $nodeCommand.Source
} else {
    $nodeExecutable = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}

if (-not (Test-Path -LiteralPath $nodeExecutable)) {
    Write-Host "找不到 Node.js。請先安裝 Node.js，或從 Codex 內啟動此工具。" -ForegroundColor Red
    Read-Host "按 Enter 結束"
    exit 1
}

Set-Location -LiteralPath $toolDirectory
$env:OPEN_BROWSER = "1"
& $nodeExecutable (Join-Path $toolDirectory "server.js")

