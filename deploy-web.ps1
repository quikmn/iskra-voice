# Deploy iskra_client_web to Cloudflare Pages via Wrangler
# Usage: .\deploy-web.ps1
# Requires: npm install -g wrangler + wrangler login

$ErrorActionPreference = 'Stop'
$root   = $PSScriptRoot
$webDir = Join-Path $root 'iskra_client_web'

# Sync latest assets from the single source of truth
Write-Host "Syncing assets from iskra_client..." -ForegroundColor Cyan
Copy-Item (Join-Path $root 'iskra_client\index.html') (Join-Path $webDir 'index.html') -Force
$soundsSrc = Join-Path $root 'iskra_client\sounds'
$soundsDst = Join-Path $webDir 'sounds'
if (-not (Test-Path $soundsDst)) { New-Item -ItemType Directory -Path $soundsDst | Out-Null }
Copy-Item (Join-Path $soundsSrc '*') $soundsDst -Force

Write-Host "Deploying to Cloudflare Pages..." -ForegroundColor Cyan
npx wrangler pages deploy $webDir --project-name iskra-webclient --branch main

Write-Host "Done! Web client deployed." -ForegroundColor Green
