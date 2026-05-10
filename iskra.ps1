<#
.SYNOPSIS
  Iskra build + ship orchestrator.
.DESCRIPTION
  .\iskra.ps1 -build <targets> -ship <targets>
  Targets: client, server, relay, web, android

  -build  = compile locally only, no deploy
  -ship   = compile + deploy (ship implies build; no double-build if both specified)
  -Publish = also push client zip + android APK to a GitHub release
  -Canary  = mark GitHub release as pre-release (used with -Publish)

.EXAMPLE
  .\iskra.ps1 -ship client,web,android
  .\iskra.ps1 -build server,relay
  .\iskra.ps1 -build server -ship client,web
  .\iskra.ps1 -ship client,server,relay,web,android -Publish
#>
param(
    [string]$build   = "",
    [string]$ship    = "",
    [switch]$Publish,
    [switch]$Canary
)

$ErrorActionPreference = 'Stop'
$root         = $PSScriptRoot
$validTargets = @('client','server','relay','web','android')

# ── Helpers ───────────────────────────────────────────────────────────────────

function Parse-Targets([string]$s) {
    if (-not $s) { return @() }
    $targets = $s.ToLower() -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    foreach ($t in $targets) {
        if ($t -notin $validTargets) {
            Write-Host "Unknown target '$t'. Valid: $($validTargets -join ', ')" -ForegroundColor Red; exit 1
        }
    }
    return [string[]]$targets
}

function Step([string]$label) {
    $bar = '━' * [Math]::Max(2, 62 - $label.Length)
    Write-Host ""
    Write-Host "━━ $label $bar" -ForegroundColor Cyan
}
function Ok([string]$m)   { Write-Host "  v $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Info([string]$m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Die([string]$m)  { Write-Host "  x $m" -ForegroundColor Red; exit 1 }

# ── Build functions (compile only, no deploy) ─────────────────────────────────

function Build-Client {
    Step "BUILD client"
    & (Join-Path $root 'build-client.ps1')
    if ($LASTEXITCODE -ne 0) { Die "Client build failed" }
    Ok "Client compiled"
}

function Build-Server {
    Step "BUILD server"
    $pub = Join-Path $root 'iskra_server\publish-linux'
    dotnet publish (Join-Path $root 'iskra_server\iskra_server.csproj') `
        -c Release -r linux-x64 --self-contained true `
        -p:PublishSingleFile=true -p:DebugType=none -o $pub --nologo 2>&1 |
        Select-String '(error\s|Error\s|succeeded|FAILED)' | ForEach-Object { Info "$_" }
    if ($LASTEXITCODE -ne 0) { Die "Server build failed" }
    Ok "Server binary → $pub"
}

function Build-Relay {
    Step "BUILD relay"
    $pub = Join-Path $root 'iskra_relay\publish'
    dotnet publish (Join-Path $root 'iskra_relay\iskra_relay.csproj') `
        -c Release -r linux-x64 --self-contained false -o $pub --nologo 2>&1 |
        Select-String '(error\s|Error\s|succeeded|FAILED)' | ForEach-Object { Info "$_" }
    if ($LASTEXITCODE -ne 0) { Die "Relay build failed" }
    Ok "Relay binary → $pub"
}

function Build-Web {
    Step "BUILD web"
    $webDir = Join-Path $root 'iskra_client_web'
    Copy-Item (Join-Path $root 'iskra_client\index.html') (Join-Path $webDir 'index.html') -Force
    $soundsDst = Join-Path $webDir 'sounds'
    if (-not (Test-Path $soundsDst)) { New-Item -ItemType Directory -Path $soundsDst | Out-Null }
    Copy-Item (Join-Path $root 'iskra_client\sounds\*') $soundsDst -Force
    Copy-Item (Join-Path $root 'iskra_client\rnnoise.wasm') (Join-Path $webDir 'rnnoise.wasm') -Force
    Copy-Item (Join-Path $root 'iskra_client\rnnoise-processor.js') (Join-Path $webDir 'rnnoise-processor.js') -Force
    Ok "Web assets synced"
}

function Build-Android {
    Step "BUILD android"
    $androidDir = Join-Path $root 'iskra_client_android'
    Push-Location $androidDir
    try {
        npx cap sync android 2>&1 |
            Where-Object { $_ -match '(error|warning|success|copy|update)' } |
            ForEach-Object { Info "$_" }
        Push-Location (Join-Path $androidDir 'android')
        try {
            & '.\gradlew.bat' assembleDebug --quiet
            if ($LASTEXITCODE -ne 0) { Die "Gradle build failed" }
        } finally { Pop-Location }
        $apk = Get-ChildItem -Path $androidDir -Recurse -Filter '*.apk' |
            Where-Object { $_.FullName -match 'debug' -and $_.Name -notmatch 'unsigned' } |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $apk) { Die "APK not found after gradle build" }
        $dest = Join-Path $root 'Iskra-Android.apk'
        Copy-Item $apk.FullName $dest -Force
        $sizeMB = [math]::Round((Get-Item $dest).Length / 1MB, 1)
        Ok "APK → Iskra-Android.apk ($sizeMB MB)"
    } finally { Pop-Location }
}

# ── Ship functions (compile + deploy) ─────────────────────────────────────────

function Ship-Client {
    Step "SHIP client"
    $shipArgs = @()
    if ($Publish) { $shipArgs += '-Publish' }
    if ($Canary)  { $shipArgs += '-Canary' }
    & (Join-Path $root 'ship-client.ps1') @shipArgs
    if ($LASTEXITCODE -ne 0) { Die "Client ship failed" }
    Ok "Client shipped"
}

function Ship-Server {
    Step "SHIP server"
    Push-Location $root
    bash ./deploy-server.sh --yes
    $ec = $LASTEXITCODE
    Pop-Location
    if ($ec -ne 0) { Die "Server deploy failed" }
    Ok "Server deployed and restarted"

    # Package server zip for distribution
    $pub     = Join-Path $root 'iskra_server\publish-linux'
    $zipPath = Join-Path $root 'Iskra-Server.zip'
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path "$pub\*" -DestinationPath $zipPath
    $sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Ok "Server zipped → Iskra-Server.zip ($sizeMB MB)"

    if ($Publish) {
        $tag = (Get-Content (Join-Path $root 'iskra_client\version.txt') -Raw -ErrorAction SilentlyContinue)?.Trim()
        if (-not $tag) { Warn "version.txt missing — skipping server zip upload"; return }
        $existing = & gh release view $tag 2>&1
        if ($LASTEXITCODE -eq 0) {
            gh release upload $tag $zipPath --clobber
        } else {
            Info "Release $tag not yet created — server zip will be uploaded by client/android step"
            # Store path for later upload if needed
        }
        if ($LASTEXITCODE -eq 0) { Ok "Server zip published → $tag" }
    }
}

function Ship-Relay {
    Step "SHIP relay"
    Push-Location $root
    bash ./deploy-relay.sh
    $ec = $LASTEXITCODE
    Pop-Location
    if ($ec -ne 0) { Die "Relay deploy failed" }
    Ok "Relay deployed and restarted"
}

function Ship-Web {
    Step "SHIP web"
    & (Join-Path $root 'deploy-web.ps1')
    if ($LASTEXITCODE -ne 0) { Die "Web deploy failed" }
    Ok "Web client deployed to CF Pages"
}

function Ship-Android {
    Step "SHIP android"
    $apkPath = Join-Path $root 'Iskra-Android.apk'
    if (-not (Test-Path $apkPath)) { Build-Android }

    if ($Publish) {
        $tag = (Get-Content (Join-Path $root 'iskra_client\version.txt') -Raw -ErrorAction SilentlyContinue)?.Trim()
        if (-not $tag) { Die "iskra_client\version.txt missing or empty — cannot publish" }

        $serverZip = Join-Path $root 'Iskra-Server.zip'
        $clientZip = Join-Path $root 'Iskra-Client.zip'

        $existing = & gh release view $tag 2>&1
        if ($LASTEXITCODE -eq 0) {
            Info "Release $tag exists — uploading/replacing assets..."
            gh release upload $tag $apkPath --clobber
            if (Test-Path $clientZip) { gh release upload $tag $clientZip --clobber }
            if (Test-Path $serverZip) { gh release upload $tag $serverZip --clobber }
        } else {
            Info "Creating release $tag..."
            $assets = @($apkPath)
            if (Test-Path $clientZip) { $assets += $clientZip }
            if (Test-Path $serverZip) { $assets += $serverZip }
            $ghArgs = @('release','create',$tag) + $assets + @('--title',"Iskra $tag",'--generate-notes','--latest')
            if ($Canary) { $ghArgs += '--prerelease' }
            & gh @ghArgs
        }
        if ($LASTEXITCODE -ne 0) { Die "GitHub release upload failed" }
        Ok "Published → github.com/quikmn/iskra-voice/releases/tag/$tag"
    } else {
        Ok "Android APK built locally (add -Publish to push to GitHub release)"
    }
}

# ── Main ──────────────────────────────────────────────────────────────────────

$buildTargets = Parse-Targets $build
$shipTargets  = Parse-Targets $ship

if ($buildTargets.Count -eq 0 -and $shipTargets.Count -eq 0) {
    Write-Host @"

Usage: .\iskra.ps1 -build <targets> -ship <targets>

Targets (comma-separated): client, server, relay, web, android

  -build   compile locally, no deploy
  -ship    compile + deploy  (implies build; won't double-build if both flags set)
  -Publish also push to GitHub release (client zip + android APK)
  -Canary  mark GitHub release as pre-release (use with -Publish)

Examples:
  .\iskra.ps1 -ship client,web,android
  .\iskra.ps1 -build server,relay
  .\iskra.ps1 -build server -ship client,web
  .\iskra.ps1 -ship client,server,relay,web,android -Publish
"@ -ForegroundColor Yellow
    exit 0
}

# Build-only targets (those not also being shipped — ship scripts handle their own build)
$buildOnly = $buildTargets | Where-Object { $shipTargets -notcontains $_ }
foreach ($t in $buildOnly) {
    switch ($t) {
        'client'  { Build-Client  }
        'server'  { Build-Server  }
        'relay'   { Build-Relay   }
        'web'     { Build-Web     }
        'android' { Build-Android }
    }
}

# Ship targets
$androidBuiltInThisRun = ($buildOnly -contains 'android')
foreach ($t in $shipTargets) {
    switch ($t) {
        'client'  { Ship-Client  }
        'server'  { Ship-Server  }
        'relay'   { Ship-Relay   }
        'web'     { Ship-Web     }
        'android' {
            # If android was already built in the build-only phase, skip rebuild inside Ship-Android
            if ($androidBuiltInThisRun) {
                $apkPath = Join-Path $root 'Iskra-Android.apk'
                if (Test-Path $apkPath) {
                    Step "SHIP android (using already-built APK)"
                    if ($Publish) {
                        $tag = (Get-Content (Join-Path $root 'iskra_client\version.txt') -Raw -ErrorAction SilentlyContinue)?.Trim()
                        if (-not $tag) { Die "iskra_client\version.txt missing or empty" }
                        $existing = & gh release view $tag 2>&1
                        if ($LASTEXITCODE -eq 0) {
                            gh release upload $tag $apkPath --clobber
                        } else {
                            $ghArgs = @('release','create',$tag,$apkPath,'--title',"Iskra $tag",'--generate-notes','--latest')
                            if ($Canary) { $ghArgs += '--prerelease' }
                            & gh @ghArgs
                        }
                        if ($LASTEXITCODE -ne 0) { Die "GitHub APK upload failed" }
                        Ok "Android APK published → $tag"
                    } else {
                        Ok "Android APK ready (add -Publish to push to GitHub release)"
                    }
                } else { Ship-Android }
            } else { Ship-Android }
        }
    }
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor DarkGray
Write-Host "  All done." -ForegroundColor Green
Write-Host ""
