# Build Iskra Android APK via Capacitor
# Usage:
#   .\ship-android.ps1        — sync + build debug APK → Iskra-Android.apk
#   .\ship-android.ps1 -Open  — sync + open Android Studio instead
param([switch]$Open)

$ErrorActionPreference = 'Stop'
$root       = $PSScriptRoot
$androidDir = Join-Path $root 'iskra_client_android'
$apkOut     = Join-Path $root 'Iskra-Android.apk'

Write-Host "Syncing Capacitor assets..." -ForegroundColor Cyan
Set-Location $androidDir
npx cap sync android 2>&1 | Where-Object { $_ -match '(error|warning|success|copy|update)' }

if ($Open) {
    Write-Host "Opening Android Studio..." -ForegroundColor Cyan
    npx cap open android
    Set-Location $root
    exit 0
}

Write-Host "Building debug APK..." -ForegroundColor Cyan
Set-Location (Join-Path $androidDir 'android')
& '.\gradlew.bat' assembleDebug --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "APK build failed." -ForegroundColor Red; Set-Location $root; exit 1 }

$apk = Get-ChildItem -Recurse -Filter '*.apk' |
    Where-Object { $_.FullName -match 'debug' -and $_.Name -notmatch 'unsigned' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $apk) {
    Write-Host "APK not found after build." -ForegroundColor Red
    Set-Location $root; exit 1
}

Copy-Item $apk.FullName $apkOut -Force
$sizeMB = [math]::Round((Get-Item $apkOut).Length / 1MB, 1)
Write-Host "Done! $apkOut ($sizeMB MB)" -ForegroundColor Green

Set-Location $root
