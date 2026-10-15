#Requires -Version 7
# Step of the Release workflow (release-all.yml, job "home PC checks"); not run by hand. The checks only the home PC can
# answer, before anything is changed: SimplySign signs (logging itself in once with the stored seed when it isn't
# logged in), and what the Windows and Android builds need is here. The same checks as scripts/release.ps1's.
#
#   release-pc-checks.ps1 [-SkipAndroid] [-PlayKey] [-Version <v>]
#
# -SkipAndroid: the Android app is built on GitHub (variable ANDROID_BUILD = ci). -PlayKey: Google Play uploads use
# this PC's service-account key file (no workload identity federation set up), so it must be there.
# Prints "ok:" and "red:" lines (and ::error:: annotations on GitHub); exit 1 when anything is red.
param([switch]$SkipAndroid, [switch]$PlayKey, [string]$Version = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $PSScriptRoot 'release-checks.psm1') -Force
# The Play check only needs a well-formed version.
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'desktop/package.json') -Raw | ConvertFrom-Json).version }
$reds = [System.Collections.Generic.List[string]]::new()
function Ok([string]$t) { Write-Host "ok: $t" }
function Red([string]$t) {
  $reds.Add($t)
  Write-Host "red: $t"
  if ($env:GITHUB_ACTIONS -eq 'true') { Write-Host "::error::$t" }
}

# SimplySign first: everything else is the PC's setup, this is the one that changes from day to day.
$s = Confirm-Signing
if ($s.Ok) {
  Ok $s.Message
  if ($s.ExpiresSoon) { Write-Host "::warning::the code-signing certificate expires on $($s.Certificate.NotAfter.ToString('yyyy-MM-dd')): renew it (docs/ci-cd.md, Windows code signing)." }
} else { Red $s.Message }

foreach ($tool in 'git', 'node', 'npm', 'gh', 'dotnet') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Red "$tool isn't installed or not on PATH for the runner's account." }
}
$drive = (Resolve-Path $root).Path.Substring(0, 1)
$free = (Get-PSDrive -Name $drive -ErrorAction SilentlyContinue).Free
if ($free -and $free -lt 10GB) { Red "only $([int]($free / 1GB)) GB free on ${drive}:; the Windows and Android builds need about 10 GB." }
elseif ($free) { Ok "$([int]($free / 1GB)) GB free on ${drive}:" }

if (-not $SkipAndroid) {
  $problems = @(Get-AndroidProblems -DevRoot (Get-DevRoot -Repo $root))
  foreach ($p in $problems) { Red "Android build: $p" }
  if (-not $problems.Count) { Ok 'Android JDK, SDK and release keystore are there (presence only)' }
}
if ($PlayKey) {
  Push-Location $root
  try {
    $out = & node scripts/play-upload.mjs $Version --check 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -eq 2) { Red 'no Google Play service-account key on this PC (docs/store/README.md), and no workload identity federation (docs/ci-cd.md, "Google Play without a key file"). Or release without the phones.' }
    elseif ($LASTEXITCODE -ne 0) { Red "Google Play: $(($out | Select-Object -Last 1) -replace '^Play upload stopped:\s*', '')" }
    else { Ok 'the Google Play key is on this PC (presence only)' }
  } finally { Pop-Location }
}

if ($reds.Count) {
  Write-Host ''
  Write-Host "$($reds.Count) thing(s) to fix on the home PC (nothing was changed)."
  exit 1
}
Ok 'the home PC is ready'
