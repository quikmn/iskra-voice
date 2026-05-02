# Build script for iskra_server
# Usage: .\build-server.ps1 [-Configuration Release|Debug] [-Verbose]

param(
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release',
    [switch]$VerboseOutput
)

$ErrorActionPreference = 'Stop'
$projectPath = Join-Path $PSScriptRoot 'iskra_server\iskra_server.csproj'

if (-not (Test-Path $projectPath)) {
    Write-Host "ERROR: Project not found at $projectPath" -ForegroundColor Red
    exit 1
}

Write-Host "Building iskra_server ($Configuration)..." -ForegroundColor Cyan

if ($VerboseOutput) {
    dotnet build $projectPath -c $Configuration
    exit $LASTEXITCODE
}

# Concise output: only errors, warnings, and the final result line
$output = dotnet build $projectPath -c $Configuration --nologo 2>&1
$exitCode = $LASTEXITCODE

$filtered = $output | Select-String -Pattern 'error |warning |Build succeeded|Build FAILED|\d+ Error\(s\)|\d+ Warning\(s\)'

if ($filtered) {
    $filtered | ForEach-Object {
        $line = $_.ToString()
        if ($line -match 'error ') {
            Write-Host $line -ForegroundColor Red
        } elseif ($line -match 'warning ') {
            Write-Host $line -ForegroundColor Yellow
        } elseif ($line -match 'succeeded') {
            Write-Host $line -ForegroundColor Green
        } elseif ($line -match 'FAILED') {
            Write-Host $line -ForegroundColor Red
        } else {
            Write-Host $line
        }
    }
}

if ($exitCode -ne 0) {
    Write-Host "Build failed with exit code $exitCode" -ForegroundColor Red
}

exit $exitCode
