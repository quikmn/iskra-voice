# Builds the signed Android app: release/Iskra-<version>.apk and release/Iskra-<version>.aab.
# The version comes from desktop/package.json. See README.md for the one-time setup.
#
#   .\android\build.ps1            # APK + AAB
#   .\android\build.ps1 -ApkOnly
#
# Overrides (environment): ISKRA_ANDROID_JDK, ISKRA_ANDROID_SDK, ISKRA_ANDROID_KEYSTORE, ISKRA_ANDROID_KEYSTORE_PASSWORD
# (or ISKRA_ANDROID_KEYSTORE_INFO, a text file with a "password=..." line).
param([switch]$ApkOnly)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
# Tools and keys live outside the repo, in the nearest parent folder that has devtools\ (D:\Development_Projects here).
$devRoot = Split-Path $here -Parent
while ($devRoot -and -not (Test-Path (Join-Path $devRoot 'devtools'))) { $devRoot = Split-Path $devRoot -Parent }
if (-not $devRoot) { $devRoot = 'D:\Development_Projects' }

function Setting($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }

$jdk = Setting 'ISKRA_ANDROID_JDK' (Join-Path $devRoot 'devtools\jdk-17')
$sdk = Setting 'ISKRA_ANDROID_SDK' (Join-Path $devRoot 'devtools\android-sdk')
$keystore = Setting 'ISKRA_ANDROID_KEYSTORE' (Join-Path $devRoot 'devkeys\iskra-android.keystore')
$keyInfo = Setting 'ISKRA_ANDROID_KEYSTORE_INFO' (Join-Path $devRoot 'devkeys\iskra-android-keystore.txt')
$alias = 'iskra'
$buildTools = Join-Path $sdk 'build-tools\36.1.0'

foreach ($p in @($jdk, $sdk, $buildTools, $keystore)) {
  if (-not (Test-Path $p)) { throw "Missing $p (see android/README.md)" }
}

$password = [Environment]::GetEnvironmentVariable('ISKRA_ANDROID_KEYSTORE_PASSWORD')
if (-not $password) {
  if (-not (Test-Path $keyInfo)) { throw "No keystore password: set ISKRA_ANDROID_KEYSTORE_PASSWORD or create $keyInfo" }
  $line = Get-Content $keyInfo | Where-Object { $_ -match '^password=' } | Select-Object -First 1
  if (-not $line) { throw "$keyInfo has no password= line" }
  $password = $line.Substring('password='.Length).Trim()
}

# Version name from the desktop app; version code ordered so every release upgrades the last one:
# major.minor.patch * 1000 + stage (alpha 1xx, beta 2xx, rc 3xx, final 900) + prerelease number.
$version = (Get-Content (Join-Path $here '..\desktop\package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$') { throw "Can't make an Android version code from '$version'" }
$stage = @{ alpha = 100; beta = 200; rc = 300 }
$pre = if ($Matches[4]) { $stage[$Matches[4]] + [int]$Matches[5] } else { 900 }
if ([int]$Matches[5] -ge 100) { throw "Prerelease number too large for the version code: $version" }
$versionCode = ([int]$Matches[1] * 10000 + [int]$Matches[2] * 100 + [int]$Matches[3]) * 1000 + $pre
Write-Host "Iskra for Android $version (version code $versionCode)"

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$jdk\bin;$env:Path"

$tasks = @('assembleRelease')
if (-not $ApkOnly) { $tasks += 'bundleRelease' }
Push-Location $here
try {
  & .\gradlew.bat @tasks --no-daemon --console=plain "-PiskraVersionCode=$versionCode" "-PiskraVersionName=$version"
  if ($LASTEXITCODE -ne 0) { throw "Gradle failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$out = Join-Path $here 'release'
New-Item -ItemType Directory -Force $out | Out-Null
$apk = Join-Path $out "Iskra-$version.apk"
$aligned = Join-Path $here 'app\build\outputs\apk\release\app-release-aligned.apk'

$env:ISKRA_KS_PASS = $password
try {
  & "$buildTools\zipalign.exe" -f -p 4 (Join-Path $here 'app\build\outputs\apk\release\app-release-unsigned.apk') $aligned
  if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }
  & "$buildTools\apksigner.bat" sign --ks $keystore --ks-key-alias $alias --ks-pass env:ISKRA_KS_PASS --key-pass env:ISKRA_KS_PASS --out $apk $aligned
  if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }
  & "$buildTools\apksigner.bat" verify $apk | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'APK signature check failed' }
  Remove-Item -ErrorAction SilentlyContinue "$apk.idsig"

  if (-not $ApkOnly) {
    $aab = Join-Path $out "Iskra-$version.aab"
    Copy-Item -Force (Join-Path $here 'app\build\outputs\bundle\release\app-release.aab') $aab
    & "$jdk\bin\jarsigner.exe" -keystore $keystore -storepass:env ISKRA_KS_PASS -keypass:env ISKRA_KS_PASS -sigalg SHA256withRSA -digestalg SHA-256 $aab $alias | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'jarsigner failed' }
    Write-Host "Built $aab"
  }
} finally { Remove-Item Env:\ISKRA_KS_PASS -ErrorAction SilentlyContinue }

Write-Host "Built $apk"
