# Run as Administrator
New-NetFirewallRule -DisplayName "Iskra Server 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
Write-Host "Done." -ForegroundColor Green
