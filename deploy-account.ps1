# Deploy iskra_account to Cloudflare Pages via Wrangler
# Usage: .\deploy-account.ps1
# Requires: npm install -g wrangler + wrangler login

$ErrorActionPreference = 'Stop'
$root       = $PSScriptRoot
$accountDir = Join-Path $root 'iskra_account'

Write-Host "Deploying account.iskra.foo to Cloudflare Pages..." -ForegroundColor Cyan
npx wrangler pages deploy $accountDir --project-name iskra-account --branch main

Write-Host "Done! Account page deployed." -ForegroundColor Green
