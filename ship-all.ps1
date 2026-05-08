# Build and ship all clients from a single command.
# Usage:
#   .\ship-all.ps1 -Version v1.2   — full ship: build + deploy live + GitHub release
#   .\ship-all.ps1                 — build + deploy live, no GitHub release
#   .\ship-all.ps1 -WebOnly        — web client only (no native, no Android)
#   .\ship-all.ps1 -NativeOnly     — native + server + Android, no web deploy
#   .\ship-all.ps1 -SkipDeploy     — skip live server deploy
#   .\ship-all.ps1 -SkipAndroid    — skip Android APK build

param(
    [string]$Version,
    [switch]$WebOnly,
    [switch]$NativeOnly,
    [switch]$SkipDeploy,
    [switch]$SkipAndroid
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if ($Version) {
    $verFile = Join-Path $root 'iskra_client\version.txt'
    Set-Content $verFile -Value $Version -NoNewline -Encoding UTF8
    Write-Host "Version set to $Version" -ForegroundColor Cyan
}

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

if (-not $WebOnly -and -not $SkipAndroid) {
    Write-Host "==> Building Android APK..." -ForegroundColor Cyan
    & (Join-Path $root 'ship-android.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host "Android build failed." -ForegroundColor Red; exit 1 }
}

if (-not $WebOnly -and -not $SkipDeploy) {
    Write-Host "==> Deploying to live server..." -ForegroundColor Cyan
    & (Join-Path $root 'update-server.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host "Live server deploy failed." -ForegroundColor Red; exit 1 }
}

if ($Version -and -not $WebOnly) {
    Write-Host "==> Creating GitHub release $Version..." -ForegroundColor Cyan

    git tag $Version
    git push origin $Version

    $clientZip  = Join-Path $root 'Iskra-Client.zip'
    $serverZip  = Join-Path $root 'Iskra-Server.zip'
    $androidApk = Join-Path $root 'Iskra-Android.apk'

    $assets = @($clientZip, $serverZip)
    if (-not $SkipAndroid -and (Test-Path $androidApk)) { $assets += $androidApk }

    gh release create $Version @assets `
        --title "Iskra $Version" `
        --generate-notes `
        --latest

    Write-Host "Release live: https://github.com/quikmn/iskra-voice/releases/tag/$Version" -ForegroundColor Green
}

Write-Host ""
Write-Host "All done." -ForegroundColor Green
