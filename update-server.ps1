# Push latest iskra_server build to the live Linux box and restart cleanly.
# Usage: .\update-server.ps1

$ErrorActionPreference = 'Stop'

$Remote     = "root@146.190.226.221"
$RemoteApp  = "/opt/iskra-server/app"
$PublishDir = "$PSScriptRoot\iskra_server\publish-linux"

# ── build ─────────────────────────────────────────────────────────────────────
Write-Host "Building linux binary..." -ForegroundColor Cyan
& dotnet publish "$PSScriptRoot\iskra_server\iskra_server.csproj" `
    -c Release `
    -r linux-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:DebugType=none `
    -o $PublishDir `
    --nologo 2>&1 | Where-Object { $_ -match 'error|warning|succeeded|FAILED' }

if ($LASTEXITCODE -ne 0) { Write-Host "Build failed." -ForegroundColor Red; exit 1 }
Write-Host "Build OK" -ForegroundColor Green

# ── stop → swap binary → start ───────────────────────────────────────────────
Write-Host "Stopping service..." -ForegroundColor Cyan
& ssh $Remote "systemctl stop iskra-server"

Write-Host "Uploading binary..." -ForegroundColor Cyan
& scp "$PublishDir\iskra_server" "${Remote}:${RemoteApp}/iskra_server"
if ($LASTEXITCODE -ne 0) { Write-Host "Upload failed." -ForegroundColor Red; exit 1 }

Write-Host "Starting service..." -ForegroundColor Cyan
& ssh $Remote "chmod +x $RemoteApp/iskra_server && systemctl start iskra-server && systemctl status iskra-server --no-pager -l"

Write-Host ""
Write-Host "Done. Server is live at 146.190.226.221:8080" -ForegroundColor Green
