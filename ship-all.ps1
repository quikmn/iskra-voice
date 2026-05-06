# Build and ship all clients from a single command.
# Usage:
#   .\ship-all.ps1           — ship native client + web client
#   .\ship-all.ps1 -WebOnly  — web client only (no GitHub release)
#   .\ship-all.ps1 -NativeOnly — native + server GitHub release only

param(
    [switch]$WebOnly,
    [switch]$NativeOnly
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not $WebOnly) {
    Write-Host "==> Building native client..." -ForegroundColor Cyan
    & (Join-Path $root 'ship-client.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host "Native client build failed." -ForegroundColor Red; exit 1 }

    Write-Host "==> Building server..." -ForegroundColor Cyan
    & (Join-Path $root 'build-server.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host "Server build failed." -ForegroundColor Red; exit 1 }

    $serverBin = Join-Path $root 'iskra_server\bin\Release\net8.0'
    $serverZip = Join-Path $root 'Iskra-Server.zip'
    if (Test-Path $serverZip) { Remove-Item $serverZip }
    Add-Type -Assembly 'System.IO.Compression.FileSystem'
    $zip = [System.IO.Compression.ZipFile]::Open($serverZip, 'Create')
    Get-ChildItem $serverBin -Recurse -File |
        Where-Object { $_.Extension -notin @('.pdb', '.xml') } |
        ForEach-Object {
            $rel = $_.FullName.Substring($serverBin.Length + 1)
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
        }
    $zip.Dispose()
    Write-Host "Server zipped." -ForegroundColor Green
}

if (-not $NativeOnly) {
    Write-Host "==> Deploying web client..." -ForegroundColor Cyan
    & (Join-Path $root 'deploy-web.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host "Web deploy failed." -ForegroundColor Red; exit 1 }
}

Write-Host ""
Write-Host "All done." -ForegroundColor Green
if (-not $WebOnly) {
    Write-Host "  Native client: Iskra-Client.zip" -ForegroundColor Gray
    Write-Host "  Server:        Iskra-Server.zip" -ForegroundColor Gray
    Write-Host "  Upload both to GitHub: gh release upload <tag> Iskra-Client.zip Iskra-Server.zip" -ForegroundColor Gray
}
