# Downloads the pinned LiveKit server into v2/.tools and checks its SHA-256.
$ErrorActionPreference = 'Stop'
$version = '1.13.7'
$asset = "livekit_${version}_windows_amd64.zip"
$sha256 = 'e539e7d2f75807b9c9202cd2a0bf2cb3d52fc4c52978a6953e0f47bc339fe77f'

$tools = Join-Path $PSScriptRoot '..\.tools'
New-Item -ItemType Directory -Force $tools | Out-Null
$zip = Join-Path $tools $asset
Invoke-WebRequest "https://github.com/livekit/livekit/releases/download/v$version/$asset" -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $sha256) { Remove-Item $zip; throw "Checksum mismatch for $asset" }
Expand-Archive $zip -DestinationPath $tools -Force
Remove-Item $zip, (Join-Path $tools 'LICENSE') -ErrorAction SilentlyContinue
Write-Host "livekit-server $version is in $tools" -ForegroundColor Green
