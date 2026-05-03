# Build, copy index.html, and zip for distribution.
# Usage: .\ship-client.ps1

$ErrorActionPreference = 'Stop'

$root     = 'D:\Development_Projects\Iskra'
$project  = Join-Path $root 'iskra_client\iskra_client.csproj'
$binDir   = Join-Path $root 'iskra_client\bin\Release\net8.0-windows'
$indexSrc = Join-Path $root 'iskra_client\index.html'
$zipOut   = Join-Path $root 'Iskra-Client.zip'

Set-Location $root

# 1. Build
Write-Host "Building..." -ForegroundColor Cyan
$output   = dotnet build $project -c Release --nologo 2>&1
$exitCode = $LASTEXITCODE

$output | Select-String 'error |Build succeeded|Build FAILED|\d+ Error' | ForEach-Object {
    $line = $_.ToString()
    if ($line -match 'error |FAILED') {
        Write-Host $line -ForegroundColor Red
    } elseif ($line -match 'succeeded') {
        Write-Host $line -ForegroundColor Green
    } else {
        Write-Host $line
    }
}

if ($exitCode -ne 0) {
    Write-Host "Build failed -- zip not created." -ForegroundColor Red
    exit 1
}

# 2. Copy index.html
Write-Host "Copying index.html..." -ForegroundColor Cyan
Copy-Item $indexSrc (Join-Path $binDir 'index.html') -Force

# 3. Zip (skip .pdb and .xml)
Write-Host "Zipping..." -ForegroundColor Cyan
if (Test-Path $zipOut) { Remove-Item $zipOut }

Add-Type -Assembly 'System.IO.Compression.FileSystem'
$zip = [System.IO.Compression.ZipFile]::Open($zipOut, 'Create')

Get-ChildItem $binDir -Recurse -File |
    Where-Object { $_.Extension -notin @('.pdb', '.xml') } |
    ForEach-Object {
        $rel = $_.FullName.Substring($binDir.Length + 1)
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
    }

$zip.Dispose()

$sizeMB = [math]::Round((Get-Item $zipOut).Length / 1MB, 1)
Write-Host "Done! $zipOut ($sizeMB MB)" -ForegroundColor Green
