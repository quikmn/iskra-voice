# Deploy iskra_client_web to Cloudflare Pages via Wrangler
# Usage: .\deploy-web.ps1
# Requires: npm install -g wrangler + wrangler login

$ErrorActionPreference = 'Stop'
$root   = $PSScriptRoot
$webDir = Join-Path $root 'iskra_client_web'

# Sync latest index.html from the single source of truth
Write-Host "Syncing index.html from iskra_client..." -ForegroundColor Cyan
Copy-Item (Join-Path $root 'iskra_client\index.html') (Join-Path $webDir 'index.html') -Force

Write-Host "Deploying to Cloudflare Pages..." -ForegroundColor Cyan
npx wrangler pages deploy $webDir --project-name iskra-webclient --branch main

Write-Host "Done! Web client deployed." -ForegroundColor Green
