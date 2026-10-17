#Requires -Version 7
# Step of scripts/release.ps1 (the one release command); don't run it by hand. The Windows part of a release: signed
# Windows apps, the Windows server zip and the Android APK, uploaded to the GitHub release. The Android build also makes
# the app bundle for Google Play (mobile\release\Iskra-<version>.aab, from the same build as the APK); release.ps1
# uploads it to Play after the release is published.
#
#   release-windows.ps1 <version>              # build, sign, check, upload
#   release-windows.ps1 <version> -SkipBuild   # upload files already in desktop\release and mobile\release
#
#   release-windows.ps1 <version> -SkipAndroid # without the Android app (the Release workflow builds it on GitHub)
#
# Runs on the release commit (the vX tag), on this PC (scripts/release.ps1) or the home PC's runner (the Release
# workflow, release-all.yml). SimplySign Desktop must be logged in; when it isn't, the stored seed logs it in
# (scripts/simplysign-login.ps1), also when SimplySign asks to log in again in the middle of the build (a watcher fills
# its login dialog). It never prints secrets or asks anything.
param(
  [Parameter(Mandatory)][string]$Version,
  [switch]$SkipBuild,
  [switch]$SkipAndroid
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tag = "v$Version"
$repo = 'quikmn/iskra-voice'
Import-Module (Join-Path $PSScriptRoot 'release-checks.psm1') -Force
$subject = Get-SigningSubject
# One run for SimplySign's login ledger, also when started on its own (release.ps1 and GitHub already set one).
if (-not $env:ISKRA_RELEASE_RUN -and -not $env:GITHUB_RUN_ID) { $env:ISKRA_RELEASE_RUN = [guid]::NewGuid().ToString('N') }

function Stop-Release([string]$message) {
  Write-Host ''
  Write-Host "Release stopped: $message" -ForegroundColor Red
  exit 1
}
function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Native([string]$what, [scriptblock]$run) {
  & $run
  if ($LASTEXITCODE -ne 0) { Stop-Release "$what failed (exit code $LASTEXITCODE)." }
}

# ── Checks before anything slow ──
Step "Checking $tag"
if ($Version -notmatch '^\d+\.\d+\.\d+(-alpha\.\d+)?$') { Stop-Release "'$Version' isn't a release version (x.y.z or x.y.z-alpha.n, no leading v)." }
foreach ($tool in 'git', 'gh', 'node', 'npm') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-Release "$tool isn't installed or not on PATH." }
}
Push-Location $root
try {
  $pkg = (Get-Content desktop\package.json -Raw | ConvertFrom-Json).version
  if ($pkg -ne $Version) { Stop-Release "desktop/package.json is $pkg, not $Version. Check out the release tag: git checkout $tag" }
  $head = git rev-parse HEAD
  $tagged = git rev-parse --verify --quiet "$tag^{commit}"
  if (-not $tagged) { Stop-Release "tag $tag doesn't exist here. release.ps1 makes it; or git fetch --tags." }
  if ($head -ne $tagged) { Stop-Release "HEAD isn't the $tag commit. Check it out: git checkout $tag" }
  if (-not $SkipBuild -and (git status --porcelain)) { Stop-Release 'the working tree has changes; the release must be built from the tagged commit as is.' }

  gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Release 'the GitHub CLI is not logged in: gh auth login' }
  # The tag must be on GitHub: the Release workflow creates the release from it.
  $remoteTag = git ls-remote --tags origin "refs/tags/$tag"
  if (-not $remoteTag) { Stop-Release "tag $tag isn't on GitHub yet. Push it: git push --atomic origin main $tag" }

  if (-not $SkipBuild) {
    # Signing goes through SimplySign Desktop (Certum's cloud key). Sign a scratch file first so a logged-out
    # SimplySign fails here, in seconds, instead of after the whole build.
    Step 'Checking the code-signing certificate (SimplySign)'
    $signing = Confirm-Signing
    if (-not $signing.Ok) { Stop-Release $signing.Message }
    $cert = $signing.Certificate
    if ($signing.ExpiresSoon) { Write-Host "Warning: the code-signing certificate expires on $($cert.NotAfter.ToString('yyyy-MM-dd')). Renew it soon (docs/ci-cd.md)." -ForegroundColor Yellow }
    Write-Host "Signing works ($subject, valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))."

    # ── Windows apps and server ──
    Step 'Building the Windows apps (npm run dist; signs as it goes)'
    # sign.ps1 fails instead of leaving files unsigned when the certificate is gone (SimplySign logged out).
    $env:ISKRA_REQUIRE_SIGNING = '1'
    if (Test-NodeModulesStale client) { Native 'npm ci (client)' { npm --prefix client ci } }
    if (Test-NodeModulesStale desktop) { Native 'npm ci (desktop)' { npm --prefix desktop ci } }
    $log = Join-Path ([IO.Path]::GetTempPath()) "iskra-dist-$Version.log"
    # SimplySign's session (2 hours per login) can end during the build. Then SimplySign shows its login dialog and the
    # signature waits: a hidden watcher fills it with the stored seed while the signing steps run (or closes it when it
    # can't, so the build fails here instead of waiting). If SimplySign is logged out outright, signing fails: then it
    # logs itself in again once (when a seed is stored and the ledger allows it) and the build runs once more.
    for ($try = 1; ; $try++) {
      Remove-Item -Recurse -Force desktop\release -ErrorAction SilentlyContinue
      Push-Location desktop
      $watcher = Start-LoginWatcher
      try {
        npm run dist 2>&1 | Tee-Object -FilePath $log
        $code = $LASTEXITCODE
      } finally { Stop-LoginWatcher $watcher; Pop-Location }
      if ($code -eq 0) { break }
      $text = Get-Content $log -Raw
      if ($text -notmatch 'Signing failed|No provider was specified|No certificates were found|SignTool Error|Signing .* failed|cannot find the certificate|The specified PIN|smart card') {
        Stop-Release "npm run dist failed (exit code $code). Build log: $log"
      }
      $again = if ($try -eq 1) { Confirm-Signing } else { $null }
      if (-not $again -or -not $again.Ok -or -not $again.AutoLogin) {
        Stop-Release "signing failed during the build: SimplySign probably logged out (it does after a while). $(Get-SimplySignLoginLine) Build log: $log"
      }
      Write-Host 'SimplySign logged out during the build and logged itself in again: building once more.'
    }
    # The standalone server's peer-to-peer tunnel: one executable, signed like the server (the desktop app runs its own).
    $watcher = Start-LoginWatcher
    try {
      $sidecarOut = node desktop\scripts\build-sidecar.mjs win-x64 2>&1 | ForEach-Object { Write-Host $_; "$_" }
      $code = $LASTEXITCODE
    } finally { Stop-LoginWatcher $watcher }
    if ($code -ne 0) {
      if (($sidecarOut -join "`n") -match 'Signing failed|Signing .* failed') { Stop-Release "signing failed during the build: SimplySign probably logged out (it does after a while). $(Get-SimplySignLoginLine)" }
      Stop-Release "build-sidecar.mjs (iskra-p2p) failed (exit code $code)."
    }
  }

  $setup = "desktop\release\Iskra-Setup-$Version.exe"
  $portable = "desktop\release\Iskra-Portable-$Version.exe"
  $server = 'desktop\build\server-win-x64\iskra-server.exe'
  $sidecar = 'desktop\build\p2p-win-x64\iskra-p2p.exe'
  $zip = "desktop\release\iskra-server-$Version-win-x64.zip"
  $apk = "mobile\release\Iskra-$Version.apk"

  Step 'Checking signatures'
  foreach ($f in $setup, $portable, $server, $sidecar) {
    if (-not (Test-Path $f)) { Stop-Release "$f is missing; the build didn't finish." }
    $sig = Get-AuthenticodeSignature $f
    if ($sig.Status -ne 'Valid') { Stop-Release "$f isn't validly signed ($($sig.Status): $($sig.StatusMessage))." }
    if ($sig.SignerCertificate.Subject -notlike "*$subject*") { Stop-Release "$f is signed by '$($sig.SignerCertificate.Subject)', expected '$subject'." }
    if (-not $sig.TimeStamperCertificate) { Stop-Release "$f has no timestamp; it would stop validating when the certificate expires." }
    Write-Host "Signed: $f"
  }

  if (-not $SkipBuild) {
    Step 'Zipping the Windows server'
    Remove-Item $zip -ErrorAction SilentlyContinue
    Compress-Archive -Path 'desktop\build\server-win-x64\*', $sidecar, 'desktop\build\p2p-win-x64\iskra-p2p-licenses.txt' -DestinationPath $zip
    Write-Host "Built $zip"

    if (-not $SkipAndroid) {
      Step 'Building the Android APK and app bundle (the Capacitor app, signed with the release key)'
      Remove-Item $apk, "mobile\release\Iskra-$Version.aab" -ErrorAction SilentlyContinue
      & .\mobile\scripts\build-android.ps1
      if (-not (Test-Path $apk)) { Stop-Release "mobile\scripts\build-android.ps1 didn't produce $apk (see its output above)." }
    }
  }

  # ── Upload ──
  $files = @($setup, "$setup.blockmap", $portable, 'desktop\release\latest.yml', $zip) + $(if ($SkipAndroid) { @() } else { @($apk) })
  foreach ($f in $files) { if (-not (Test-Path $f)) { Stop-Release "$f is missing." } }
  $latest = Get-Content desktop\release\latest.yml -Raw
  if ($latest -notmatch "(?m)^version:\s*$([regex]::Escape($Version))\s*$") { Stop-Release "desktop\release\latest.yml isn't for $Version." }

  Step 'SHA256 of the files to upload'
  foreach ($f in $files) { Write-Host ('{0}  {1}' -f (Get-FileHash $f -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $f -Leaf)) }

  Step "Uploading to the $tag release"
  gh release view $tag -R $repo *> $null
  if ($LASTEXITCODE -ne 0) {
    # The Release workflow creates it after the Linux and macOS builds; create the draft now if it hasn't yet.
    Write-Host "Release $tag doesn't exist yet: creating it as a draft."
    Native 'gh release create' { gh release create $tag -R $repo --draft --prerelease --verify-tag --title "Iskra $Version" --notes 'Linux and macOS builds are attached; Windows builds follow.' }
  }
  Native 'gh release upload' { gh release upload $tag -R $repo @files --clobber }

  # Compare what GitHub has with the local files.
  $assets = (gh release view $tag -R $repo --json assets | ConvertFrom-Json).assets
  foreach ($f in $files) {
    $name = Split-Path $f -Leaf
    $a = $assets | Where-Object name -eq $name
    if (-not $a) { Stop-Release "$name isn't on the release after uploading." }
    if ($a.size -ne (Get-Item $f).Length) { Stop-Release "$name on GitHub has a different size than the local file; upload again." }
  }
  Write-Host 'Uploaded and checked.'
} finally { Pop-Location }
