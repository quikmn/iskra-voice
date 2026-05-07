# Deploy twintwrs-profile/index.html to Neocities
# Usage: .\deploy-profile.ps1 -ApiKey "your-api-key"
# Or set $env:NEOCITIES_API_KEY and run: .\deploy-profile.ps1

param(
    [string]$ApiKey = $env:NEOCITIES_API_KEY
)

$ErrorActionPreference = 'Stop'

if (-not $ApiKey) {
    Write-Host "No API key provided." -ForegroundColor Red
    Write-Host "Get yours at: https://neocities.org/settings/twintwrs (Manage Site Settings -> API Key)" -ForegroundColor Yellow
    Write-Host "Then run: .\deploy-profile.ps1 -ApiKey `"your-key-here`"" -ForegroundColor Yellow
    exit 1
}

$file = Join-Path $PSScriptRoot 'twintwrs-profile\index.html'

if (-not (Test-Path $file)) {
    Write-Host "Could not find $file" -ForegroundColor Red
    exit 1
}

Write-Host "Uploading to twintwrs.neocities.org..." -ForegroundColor Cyan

$result = curl.exe -s -F "index.html=@$file" -H "Authorization: Bearer $ApiKey" https://neocities.org/api/upload | ConvertFrom-Json

if ($result.result -eq 'success') {
    Write-Host "Done! https://twintwrs.neocities.org" -ForegroundColor Green
} else {
    Write-Host "Upload failed: $($result | ConvertTo-Json)" -ForegroundColor Red
    exit 1
}
