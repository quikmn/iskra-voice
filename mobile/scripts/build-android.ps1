# Builds the signed Android app from the Capacitor shell: mobile\release\Iskra-<version>.apk (and .aab for Google Play).
# The version comes from desktop/package.json (scripts/mobile-version.mjs). See mobile/README.md "Android".
#
#   .\mobile\scripts\build-android.ps1            # APK + AAB
#   .\mobile\scripts\build-android.ps1 -ApkOnly
#   .\mobile\scripts\build-android.ps1 -SkipWeb   # reuse client\dist as it is
#   .\mobile\scripts\build-android.ps1 -Rebuild 1   # the same version again for Google Play (it never takes a version code twice)
#
# Overrides (environment): ISKRA_ANDROID_JDK (JDK 21+), ISKRA_ANDROID_SDK, ISKRA_ANDROID_KEYSTORE,
# ISKRA_ANDROID_KEYSTORE_PASSWORD (or ISKRA_ANDROID_KEYSTORE_INFO, a text file with a "password=..." line).
param([switch]$ApkOnly, [switch]$SkipWeb, [ValidateRange(0, 9)][int]$Rebuild = 0)

$ErrorActionPreference = 'Stop'
$mobile = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $mobile -Parent
$project = Join-Path $mobile 'android'

# Tools and keys live outside the repo, in the nearest parent folder that has devtools\ (D:\Development_Projects here).
$devRoot = $repo
while ($devRoot -and -not (Test-Path (Join-Path $devRoot 'devtools'))) { $devRoot = Split-Path $devRoot -Parent }
if (-not $devRoot) { $devRoot = 'D:\Development_Projects' }

function Setting($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }

function JdkVersion($path) {
  $release = Join-Path $path 'release'
  if (-not (Test-Path $release)) { return 0 }
  $line = Get-Content $release | Where-Object { $_ -match '^JAVA_VERSION="(\d+)' } | Select-Object -First 1
  if ($line -match '^JAVA_VERSION="(\d+)') { [int]$Matches[1] } else { 0 }
}

# Capacitor 8 needs JDK 21: the override, devtools\jdk-21, JAVA_HOME, or the usual install folder.
$jdk = @((Setting 'ISKRA_ANDROID_JDK' ''), (Join-Path $devRoot 'devtools\jdk-21'), $env:JAVA_HOME, 'C:\Program Files\Java\jdk-21') |
  Where-Object { $_ -and (JdkVersion $_) -ge 21 } | Select-Object -First 1
if (-not $jdk) { throw 'No JDK 21 found: install Temurin 21 into devtools\jdk-21 or set ISKRA_ANDROID_JDK (see mobile/README.md)' }
$sdk = Setting 'ISKRA_ANDROID_SDK' (Join-Path $devRoot 'devtools\android-sdk')
$keystore = Setting 'ISKRA_ANDROID_KEYSTORE' (Join-Path $devRoot 'devkeys\iskra-android.keystore')
$keyInfo = Setting 'ISKRA_ANDROID_KEYSTORE_INFO' (Join-Path $devRoot 'devkeys\iskra-android-keystore.txt')
$alias = 'iskra'
$buildTools = Join-Path $sdk 'build-tools\36.1.0'

foreach ($p in @($sdk, $buildTools, $keystore)) {
  if (-not (Test-Path $p)) { throw "Missing $p (see mobile/README.md)" }
}

$password = [Environment]::GetEnvironmentVariable('ISKRA_ANDROID_KEYSTORE_PASSWORD')
if (-not $password) {
  if (-not (Test-Path $keyInfo)) { throw "No keystore password: set ISKRA_ANDROID_KEYSTORE_PASSWORD or create $keyInfo" }
  $line = Get-Content $keyInfo | Where-Object { $_ -match '^password=' } | Select-Object -First 1
  if (-not $line) { throw "$keyInfo has no password= line" }
  $password = $line.Substring('password='.Length).Trim()
}

# Version name and code (scripts/mobile-version.mjs: above every earlier code, so installed copies update in place).
$versionInfo = @{}
foreach ($l in (node (Join-Path $repo 'scripts\mobile-version.mjs') --android $Rebuild)) { $k, $v = $l -split '=', 2; $versionInfo[$k] = $v }
$version = $versionInfo.APP_VERSION
$versionCode = $versionInfo.VERSION_CODE
if (-not $version -or -not $versionCode) { throw 'scripts/mobile-version.mjs gave no version' }
Write-Host "Iskra for Android $version (version code $versionCode), JDK $jdk"

function Run($what, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" }
}

# The web app, bundled into the APK.
if (-not $SkipWeb) {
  Push-Location (Join-Path $repo 'client')
  try {
    if (-not (Test-Path node_modules)) { Run 'npm ci (client)' { npm ci } }
    Run 'client build' { npm run build }
  } finally { Pop-Location }
}
Push-Location $mobile
try {
  if (-not (Test-Path node_modules)) { Run 'npm ci (mobile)' { npm ci } }
  Run 'cap sync android' { npx cap sync android }
} finally { Pop-Location }

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$jdk\bin;$env:Path"

$tasks = @('assembleRelease')
if (-not $ApkOnly) { $tasks += 'bundleRelease' }
Push-Location $project
try {
  Run 'Gradle' { & .\gradlew.bat @tasks --no-daemon --console=plain "-PiskraVersionCode=$versionCode" "-PiskraVersionName=$version" }
} finally { Pop-Location }

$out = Join-Path $mobile 'release'
New-Item -ItemType Directory -Force $out | Out-Null
$apk = Join-Path $out "Iskra-$version.apk"
$built = Join-Path $project 'app\build\outputs\apk\release'
$aligned = Join-Path $built 'app-release-aligned.apk'

$env:ISKRA_KS_PASS = $password
try {
  Run 'zipalign' { & "$buildTools\zipalign.exe" -f -p 4 (Join-Path $built 'app-release-unsigned.apk') $aligned }
  Run 'apksigner' { & "$buildTools\apksigner.bat" sign --ks $keystore --ks-key-alias $alias --ks-pass env:ISKRA_KS_PASS --key-pass env:ISKRA_KS_PASS --out $apk $aligned }
  Remove-Item -ErrorAction SilentlyContinue "$apk.idsig"

  # Checks: a valid signature by the same key as before (App Links and in-place updates depend on it), the right
  # package and version code.
  $certs = & "$buildTools\apksigner.bat" verify --print-certs $apk
  if ($LASTEXITCODE -ne 0) { throw 'APK signature check failed' }
  $digest = ($certs | Select-String 'Signer #1 certificate SHA-256 digest: ([0-9a-f]+)').Matches.Groups[1].Value
  $links = Get-Content (Join-Path $repo 'client\public\.well-known\assetlinks.json') -Raw | ConvertFrom-Json
  $expected = @($links[0].target.sha256_cert_fingerprints | ForEach-Object { ($_ -replace ':', '').ToLowerInvariant() })
  if ($expected -notcontains $digest) { throw "The APK is signed with a key whose fingerprint isn't in assetlinks.json ($digest): wrong keystore?" }
  $badging = & "$buildTools\aapt2.exe" dump badging $apk | Select-Object -First 1
  if ($badging -notmatch "package: name='foo\.iskra\.app' versionCode='$versionCode' versionName='$([regex]::Escape($version))'") { throw "Unexpected package line: $badging" }

  if (-not $ApkOnly) {
    $aab = Join-Path $out "Iskra-$version.aab"
    Copy-Item -Force (Join-Path $project 'app\build\outputs\bundle\release\app-release.aab') $aab
    Run 'jarsigner' { & "$jdk\bin\jarsigner.exe" -keystore $keystore -storepass:env ISKRA_KS_PASS -keypass:env ISKRA_KS_PASS -sigalg SHA256withRSA -digestalg SHA-256 $aab $alias | Out-Null }
    Write-Host "Built $aab"
  }
} finally { Remove-Item Env:\ISKRA_KS_PASS -ErrorAction SilentlyContinue }

Write-Host "Built $apk (signed by the release key, $digest)"
