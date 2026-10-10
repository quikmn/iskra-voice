# Downloads Pebble (Let's Encrypt's ACME test server) into .tools, for the automatic-HTTPS test.
$ErrorActionPreference = 'Stop'
$version = '2.10.1'
$sha256 = '2539f3903302d75f897522b23b1b52b3300f5f992245f13d3bdf3967cf23af6d'
$tools = Join-Path $PSScriptRoot '..\.tools'
New-Item -ItemType Directory -Force $tools | Out-Null
$zip = Join-Path $tools 'pebble.zip'
Invoke-WebRequest "https://github.com/letsencrypt/pebble/releases/download/v$version/pebble-windows-amd64.zip" -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $sha256) { Remove-Item $zip; throw 'Checksum mismatch for Pebble' }
Expand-Archive $zip -DestinationPath (Join-Path $tools 'pebble-x') -Force
Move-Item (Join-Path $tools 'pebble-x\pebble-windows-amd64\windows\amd64\pebble.exe') (Join-Path $tools 'pebble.exe') -Force
Remove-Item $zip, (Join-Path $tools 'pebble-x') -Recurse
Write-Host "pebble $version is in $tools" -ForegroundColor Green
