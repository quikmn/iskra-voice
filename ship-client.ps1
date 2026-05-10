# Build, copy index.html, and zip for distribution.
# Usage: .\ship-client.ps1 [-Canary] [-Publish]
#   -Canary   : creates a GitHub pre-release (canary channel, skipped by stable users)
#   -Publish  : push a GitHub release after building (requires gh CLI + version.txt tag)
param(
    [switch]$Canary,
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'

$root           = $PSScriptRoot
$project        = Join-Path $root 'iskra_client\iskra_client.csproj'
$launcherProject = Join-Path $root 'iskra_launcher\iskra_launcher.csproj'
$binDir         = Join-Path $root 'iskra_client\bin\Release\net8.0-windows'
$launcherBinDir = Join-Path $root 'iskra_launcher\bin\Release\net8.0-windows'
$indexSrc       = Join-Path $root 'iskra_client\index.html'
$zipOut         = Join-Path $root 'Iskra-Client.zip'

Set-Location $root

# Read version from version.txt, auto-increment the last digit, write it back
$versionFile = Join-Path $root 'iskra_client\version.txt'
$fullVer     = (Get-Content $versionFile -Raw).Trim()
$buildVer    = $fullVer.TrimStart('v')   # e.g. 1.1.5.0
$parts       = $buildVer.Split('.')
$parts[3]    = [string]([int]$parts[3] + 1)
if ([int]$parts[3] -gt 9) { $parts[3] = '0'; $parts[2] = [string]([int]$parts[2] + 1) }
$buildVer    = $parts -join '.'
$fullVer     = 'v' + $buildVer
Set-Content $versionFile $fullVer -NoNewline
Write-Host "Version: $fullVer (assembly: $buildVer)" -ForegroundColor Cyan

# 0. Kill launcher + client so exes aren't locked
$exeName = 'iskra_client'
foreach ($proc in @('iskra_launcher', 'iskra_client')) {
    try {
        $procs = Get-Process -Name $proc -ErrorAction SilentlyContinue
        if ($procs) {
            $procs | Stop-Process -Force
            Write-Host "Killed $($procs.Count) running instance(s) of $proc" -ForegroundColor Yellow
        }
    } catch { Write-Host "Could not kill ${proc}: $_" -ForegroundColor Yellow }
}
Start-Sleep -Milliseconds 600

# 1. Build client + launcher (inject version into exe metadata)
$verProps = "/p:Version=$buildVer /p:AssemblyVersion=$buildVer /p:FileVersion=$buildVer /p:InformationalVersion=$fullVer"

Write-Host "Building iskra_client..." -ForegroundColor Cyan
$output   = Invoke-Expression "dotnet build `"$project`" -c Release --nologo $verProps" 2>&1
$exitCode = $LASTEXITCODE
$output | Select-String 'error |Build succeeded|Build FAILED|\d+ Error' | ForEach-Object {
    $line = $_.ToString()
    if ($line -match 'error |FAILED') { Write-Host $line -ForegroundColor Red }
    elseif ($line -match 'succeeded')  { Write-Host $line -ForegroundColor Green }
    else { Write-Host $line }
}
if ($exitCode -ne 0) { Write-Host "Client build failed." -ForegroundColor Red; exit 1 }

Write-Host "Building iskra_launcher..." -ForegroundColor Cyan
$output2   = Invoke-Expression "dotnet build `"$launcherProject`" -c Release --nologo $verProps" 2>&1
$exitCode2 = $LASTEXITCODE
$output2 | Select-String 'error |Build succeeded|Build FAILED|\d+ Error' | ForEach-Object {
    $line = $_.ToString()
    if ($line -match 'error |FAILED') { Write-Host $line -ForegroundColor Red }
    elseif ($line -match 'succeeded')  { Write-Host $line -ForegroundColor Green }
    else { Write-Host $line }
}
if ($exitCode2 -ne 0) { Write-Host "Launcher build failed." -ForegroundColor Red; exit 1 }

# 2. Copy index.html + version.txt + launcher into client bin
Write-Host "Copying index.html..." -ForegroundColor Cyan
Copy-Item $indexSrc (Join-Path $binDir 'index.html') -Force
$versionSrc = Join-Path $root 'iskra_client\version.txt'
if (Test-Path $versionSrc) { Copy-Item $versionSrc (Join-Path $binDir 'version.txt') -Force }
$launcherExeSrc = Join-Path $launcherBinDir 'iskra_launcher.exe'
if (Test-Path $launcherExeSrc) {
    Copy-Item $launcherExeSrc (Join-Path $binDir 'iskra_launcher.exe') -Force
    Write-Host "Copied iskra_launcher.exe into client bin" -ForegroundColor Cyan
}

# 3. Zip (skip .pdb and .xml)
Write-Host "Zipping..." -ForegroundColor Cyan
if (Test-Path $zipOut) { Remove-Item $zipOut }

Add-Type -Assembly 'System.IO.Compression.FileSystem'
$zip = [System.IO.Compression.ZipFile]::Open($zipOut, 'Create')

# Client files (exclude iskra_launcher.exe — added from launcher bin below)
Get-ChildItem $binDir -Recurse -File |
    Where-Object { $_.Extension -notin @('.pdb', '.xml') -and $_.Name -ne 'iskra_launcher.exe' } |
    ForEach-Object {
        $rel = $_.FullName.Substring($binDir.Length + 1)
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
    }

# All launcher files (exe + dll + runtimeconfig + deps)
Get-ChildItem $launcherBinDir -File |
    Where-Object { $_.Extension -notin @('.pdb', '.xml') } |
    ForEach-Object {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $_.Name) | Out-Null
    }
Write-Host "Added launcher files to zip" -ForegroundColor Cyan

$zip.Dispose()

$sizeMB = [math]::Round((Get-Item $zipOut).Length / 1MB, 1)
Write-Host "Done! $zipOut ($sizeMB MB)" -ForegroundColor Green

# 4. Extract to ISKRATESTING
$testDir = Join-Path $root 'ISKRATESTING'
Write-Host "Extracting to $testDir..." -ForegroundColor Cyan
if (Test-Path $testDir) { Remove-Item $testDir -Recurse -Force }
New-Item -ItemType Directory -Path $testDir | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipOut, $testDir, $true)
Write-Host "Extracted to $testDir" -ForegroundColor Green

# 5. Publish GitHub release (optional) — done BEFORE relaunching
if ($Publish) {
    $tag = $fullVer
    if (-not $tag) { Write-Host "version.txt is empty — cannot publish." -ForegroundColor Red; exit 1 }

    $channelLabel = if ($Canary) { 'canary' } else { 'stable' }
    $title        = if ($Canary) { "$tag (canary)" } else { $tag }

    Write-Host "Publishing GitHub release $tag ($channelLabel)..." -ForegroundColor Cyan

    # Delete existing release+tag if present (idempotent publish)
    $existing = & gh release view $tag 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Tag $tag already exists — replacing..." -ForegroundColor Yellow
        & gh release delete $tag --yes 2>$null
        & git tag -d $tag 2>$null
        & git push origin ":refs/tags/$tag" 2>$null
    }

    $ghArgs = @('release', 'create', $tag, $zipOut,
        '--title', $title,
        '--notes', "Iskra Voice $tag ($channelLabel)")
    if ($Canary) { $ghArgs += '--prerelease' }

    & gh @ghArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "gh release create failed." -ForegroundColor Red; exit 1 }
    Write-Host "Published: $tag ($channelLabel)" -ForegroundColor Green
}

# 6. Relaunch — only after build, extract, and publish are fully done
try {
    $launcherExe = Join-Path $testDir 'iskra_launcher.exe'
    if (Test-Path $launcherExe) {
        Start-Process $launcherExe
        Write-Host "Relaunched via $launcherExe" -ForegroundColor Green
    } else {
        $clientExe = Join-Path $testDir "$exeName.exe"
        if (Test-Path $clientExe) { Start-Process $clientExe }
        Write-Host "Launcher not found, launched client directly from ISKRATESTING" -ForegroundColor Yellow
    }
} catch { Write-Host "Could not relaunch: $_" -ForegroundColor Yellow }
