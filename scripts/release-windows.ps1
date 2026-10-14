#Requires -Version 7
# The Windows part of a release (see docs/ci-cd.md): signed Windows build, Windows server zip and Android APK,
# uploaded to the GitHub release, then starts the Release finalize workflow. The Android build also makes the app
# bundle for Google Play (mobile\release\Iskra-<version>.aab, from the same build as the APK); release-all.ps1 uploads
# it to Play after the release is published.
#
#   .\scripts\release-windows.ps1 2.0.0-alpha.10
#   .\scripts\release-windows.ps1 2.0.0-alpha.10 -SkipBuild     # upload files already in desktop\release and mobile\release
#   .\scripts\release-windows.ps1 2.0.0-alpha.10 -NoFinalize    # upload only; start finalize yourself later
#
# Run it from the release commit (the vX tag), with SimplySign Desktop logged in. It never prints secrets.
param(
  [Parameter(Mandatory)][string]$Version,
  [switch]$SkipBuild,
  [switch]$NoFinalize,
  # How long to wait for the Linux and macOS builds before starting finalize.
  [int]$WaitMinutes = 60
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tag = "v$Version"
$repo = 'quikmn/iskra-voice'
$subject = 'Open Source Developer Viktor Lundgren'

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
  if (-not $tagged) { Stop-Release "tag $tag doesn't exist here. Run npm run release -- $Version first, or git fetch --tags." }
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
    $cert = Get-ChildItem Cert:\CurrentUser\My |
      Where-Object { $_.HasPrivateKey -and $_.Subject -like "*$subject*" -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') } |
      Sort-Object NotAfter -Descending | Select-Object -First 1
    if (-not $cert) { Stop-Release "no '$subject' code-signing certificate in the certificate store. Open SimplySign Desktop and log in (6-digit code from the SimplySign app), then run this again." }
    if ($cert.NotAfter -lt (Get-Date)) { Stop-Release "the code-signing certificate expired on $($cert.NotAfter.ToString('yyyy-MM-dd')). Renew it with Certum (docs/ci-cd.md, Windows code signing)." }
    if ($cert.NotAfter -lt (Get-Date).AddDays(30)) { Write-Host "Warning: the code-signing certificate expires on $($cert.NotAfter.ToString('yyyy-MM-dd')). Renew it soon (docs/ci-cd.md)." -ForegroundColor Yellow }
    $probe = Join-Path ([IO.Path]::GetTempPath()) "iskra-sign-probe-$PID.ps1"
    Set-Content -Path $probe -Value '# signing probe' -Encoding utf8
    try {
      $result = Set-AuthenticodeSignature -FilePath $probe -Certificate $cert -HashAlgorithm SHA256 -ErrorAction Stop
      if ($result.Status -ne 'Valid') { Stop-Release "SimplySign isn't logged in (test signature: $($result.StatusMessage)). Log in to SimplySign Desktop and run this again." }
    } catch {
      Stop-Release "SimplySign isn't logged in or isn't running (test signature failed: $($_.Exception.Message)). Log in to SimplySign Desktop and run this again."
    } finally { Remove-Item $probe -ErrorAction SilentlyContinue }
    Write-Host "Signing works ($subject, valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))."

    # ── Windows apps and server ──
    Step 'Building the Windows apps (npm run dist; signs as it goes)'
    if (-not (Test-Path client\node_modules)) { Native 'npm ci (client)' { npm --prefix client ci } }
    if (-not (Test-Path desktop\node_modules)) { Native 'npm ci (desktop)' { npm --prefix desktop ci } }
    Remove-Item -Recurse -Force desktop\release -ErrorAction SilentlyContinue
    $log = Join-Path ([IO.Path]::GetTempPath()) "iskra-dist-$Version.log"
    Push-Location desktop
    try {
      npm run dist 2>&1 | Tee-Object -FilePath $log
      $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -ne 0) {
      $text = Get-Content $log -Raw
      if ($text -match 'No provider was specified|No certificates were found|SignTool Error|Signing .* failed|cannot find the certificate|The specified PIN|smart card') {
        Stop-Release "signing failed during the build: SimplySign probably logged out (it does after a while). Log in again and rerun. Build log: $log"
      }
      Stop-Release "npm run dist failed (exit code $code). Build log: $log"
    }
    # The standalone server's peer-to-peer tunnel: one executable, signed like the server (the desktop app runs its own).
    Native 'build-sidecar.mjs (iskra-p2p)' { node desktop\scripts\build-sidecar.mjs win-x64 }
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
    if ($sig.Status -ne 'Valid') { Stop-Release "$f isn't validly signed ($($sig.Status): $($sig.StatusMessage)). Log in to SimplySign and rebuild." }
    if ($sig.SignerCertificate.Subject -notlike "*$subject*") { Stop-Release "$f is signed by '$($sig.SignerCertificate.Subject)', expected '$subject'." }
    if (-not $sig.TimeStamperCertificate) { Stop-Release "$f has no timestamp; it would stop validating when the certificate expires." }
    Write-Host "Signed: $f"
  }

  if (-not $SkipBuild) {
    Step 'Zipping the Windows server'
    Remove-Item $zip -ErrorAction SilentlyContinue
    Compress-Archive -Path 'desktop\build\server-win-x64\*', $sidecar, 'desktop\build\p2p-win-x64\iskra-p2p-licenses.txt' -DestinationPath $zip
    Write-Host "Built $zip"

    Step 'Building the Android APK and app bundle (the Capacitor app, signed with the release key)'
    Remove-Item $apk, "mobile\release\Iskra-$Version.aab" -ErrorAction SilentlyContinue
    & .\mobile\scripts\build-android.ps1
    if (-not (Test-Path $apk)) { Stop-Release "mobile\scripts\build-android.ps1 didn't produce $apk (see its output above)." }
  }

  # ── Upload ──
  $files = @($setup, "$setup.blockmap", $portable, 'desktop\release\latest.yml', $zip, $apk)
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

  if ($NoFinalize) {
    Write-Host ''
    Write-Host "Done. Start finalize when the Linux and macOS builds are attached: gh workflow run release-finalize.yml -R $repo -f tag=$tag"
    exit 0
  }

  # ── Wait for Linux and macOS, then finalize ──
  Step 'Waiting for the Linux and macOS builds (Release workflow)'
  $names = Join-Path ([IO.Path]::GetTempPath()) "iskra-assets-$Version.txt"
  $deadline = (Get-Date).AddMinutes($WaitMinutes)
  while ($true) {
    gh release view $tag -R $repo --json assets --jq '.assets[].name' | Set-Content -Path $names -Encoding utf8
    node scripts\release-assets.mjs names $Version $names *> $null
    if ($LASTEXITCODE -eq 0) { break }
    if ((Get-Date) -gt $deadline) {
      node scripts\release-assets.mjs names $Version $names
      Stop-Release "the release is still missing files after $WaitMinutes minutes. Check the Release workflow: gh run list -R $repo --workflow release.yml -L 3. When it's done: gh workflow run release-finalize.yml -R $repo -f tag=$tag"
    }
    Write-Host "  $(Get-Date -Format HH:mm) not all there yet; checking again in a minute"
    Start-Sleep -Seconds 60
  }
  Remove-Item $names -ErrorAction SilentlyContinue
  Write-Host 'All files are on the release.'

  Step 'Starting Release finalize'
  Native 'gh workflow run' { gh workflow run release-finalize.yml -R $repo -f tag=$tag }
  Start-Sleep -Seconds 5
  $run = gh run list -R $repo --workflow release-finalize.yml -L 1 --json url,status --jq '.[0].url'
  Write-Host "Finalize started: $run"
  Write-Host "Watch it: gh run watch -R $repo --exit-status $(($run -split '/')[-1])"
  Write-Host 'If the release environment has required reviewers, approve the run on that page.'
} finally { Pop-Location }
