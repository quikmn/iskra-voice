# Deploy iskra_server to the remote Linux host via PowerShell + Windows SSH/SCP.
# Usage: .\deploy-server.ps1
# Requires: SSH key at ~/.ssh/id_ed25519 with access to root@146.190.226.221

$ErrorActionPreference = 'Stop'

$RemoteIP   = "146.190.226.221"
$Remote     = "root@$RemoteIP"
$AppDir     = "/opt/iskra-server"
$Svc        = "iskra-server"
$Key        = "$env:USERPROFILE\.ssh\id_ed25519"
$PublishDir = "$PSScriptRoot\iskra_server\publish-linux"
$SshOpts    = @("-i", $Key, "-o", "StrictHostKeyChecking=no")

function Remote($cmd) {
    ssh @SshOpts $Remote $cmd
    if ($LASTEXITCODE -ne 0) { throw "Remote command failed: $cmd" }
}

# ── build linux binary ────────────────────────────────────────────────────────
Write-Host "==> Building iskra_server for linux-x64..." -ForegroundColor Cyan
dotnet publish "$PSScriptRoot\iskra_server\iskra_server.csproj" `
    -c Release -r linux-x64 --self-contained true `
    -p:PublishSingleFile=true -p:DebugType=none `
    -o $PublishDir --nologo 2>&1 |
    Select-String 'error |FAILED|succeeded' | ForEach-Object { Write-Host $_ }
Write-Host "--> Build done" -ForegroundColor Green

# ── stop service, upload binary, restart ─────────────────────────────────────
Write-Host "`n==> Stopping service..." -ForegroundColor Cyan
Remote "systemctl stop $Svc"

Write-Host "==> Uploading binary..." -ForegroundColor Cyan
scp @SshOpts "$PublishDir\iskra_server" "${Remote}:${AppDir}/app/iskra_server"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }
Write-Host "--> Binary uploaded" -ForegroundColor Green

Write-Host "==> Starting service..." -ForegroundColor Cyan
Remote "chmod +x $AppDir/app/iskra_server && systemctl start $Svc && sleep 2 && systemctl status $Svc --no-pager -l"

Write-Host "`n==> Done! Server running at ws://${RemoteIP}:8080" -ForegroundColor Green
Write-Host "    Logs: ssh root@$RemoteIP journalctl -u $Svc -f"
