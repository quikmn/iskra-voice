# Starts the Iskra 2 dev stack: server (on a local test world) + web client with hot reload.
# Usage: .\dev.ps1            -> world in v2\.dev\world
#        .\dev.ps1 -World gaming
param([string]$World = 'world')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$worldPath = Join-Path $root ".dev\$World"

$livekit = Join-Path $root '.tools\livekit-server.exe'
if (-not (Test-Path $livekit)) { & (Join-Path $root 'scripts\get-livekit.ps1') }
$env:ISKRA_LIVEKIT = $livekit

Write-Host "Server: world at $worldPath" -ForegroundColor Cyan
$server = Start-Process dotnet -ArgumentList @('watch', '--project', "$root\server\src\Iskra.Server", 'run', '--', $worldPath) -PassThru -NoNewWindow

try {
    Write-Host "Client: http://localhost:5173" -ForegroundColor Cyan
    Push-Location (Join-Path $root 'client')
    if (-not (Test-Path node_modules)) { npm install }
    npm run dev
}
finally {
    Pop-Location
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
