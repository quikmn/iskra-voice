#Requires -Version 7
# The one command that ships Iskra. Everything else that ships something is a step it calls (docs/ci-cd.md, "Steps").
#
#   .\scripts\release.ps1                      # release the next alpha after the latest release
#   .\scripts\release.ps1 2.0.0-alpha.20       # release that version
#   .\scripts\release.ps1 -CheckOnly           # only the check phase: every check, changes nothing (-DryRun works too)
#   .\scripts\release.ps1 -Resume              # after a STOP once the tag is pushed: picks up where it ended
#   .\scripts\release.ps1 -Redeploy site       # iskra.foo from main (-Ref <tag or branch>)
#   .\scripts\release.ps1 -Redeploy webapp     # app.iskra.foo from the latest release tag (-Ref main for main)
#   .\scripts\release.ps1 -Redeploy server     # chat.iskra.foo to the latest release (or give a version)
#   .\scripts\release.ps1 -Redeploy checksums  # SHA256SUMS.txt and attestations of the latest release (or a version) again
#   .\scripts\release.ps1 -Phones              # only the phone apps of the latest release (TestFlight, Google Play)
#   .\scripts\release.ps1 -BotSdk [0.1.2]      # the bot SDK to npm (default: the next patch version)
#   .\scripts\release.ps1 -GitHub [V]          # press GitHub's Release button instead (release-all.yml) and follow it
#                                              # (-CheckOnly: only its checks; -SkipPhones: without the phones)
#
# Every mode has two phases. The check phase runs every check and changes nothing; for a release, SimplySign's test
# signature comes first and stops at once when it isn't logged in. If anything is red it lists all of it ("N thing(s) to
# fix") and ends: nothing was sent; fix it and run the same command again. If all is green it prints
# "ALL CHECKS GREEN - SENDING" and ships without a prompt or an approval. A problem after that prints one
# "STOP [case] what to do" line (docs/ci-cd-playbook.md, decision table).
#
# The usual way to release is GitHub's Release button (Actions -> Release -> Run workflow, also in GitHub Mobile; the
# home PC must be on: docs/ci-cd.md). This script is the local alternative and the button's trigger (-GitHub).
#
# A release: notes (docs/releases/NEXT.md), version bump and tag, push (which starts the Linux and macOS builds,
# release.yml, and the iPhone build, mobile-ios.yml), the draft release, the Windows apps (signed through SimplySign),
# server zip and Android app, finalize (refuses unless CI passed on the tag; publishes, deploys iskra.foo, app.iskra.foo
# and chat.iskra.foo, uploads the iPhone build to TestFlight), Google Play where mobile/store.json says, final checks.
# Run it from main in D:\Development_Projects\Iskra. It never prints secrets, never moves tags, never force-pushes.
param(
  [Parameter(Position = 0)][string]$Version = '',
  [Alias('DryRun')][switch]$CheckOnly,
  [switch]$Resume,
  [ValidateSet('', 'site', 'webapp', 'server', 'checksums')][string]$Redeploy = '',
  # The tag or branch a site or web app redeploy builds from.
  [string]$Ref = '',
  [switch]$BotSdk,
  [switch]$Phones,
  # Start the Release workflow on GitHub (release-all.yml) instead of releasing from this PC, and follow it.
  [switch]$GitHub,
  # A release without TestFlight and Google Play.
  [switch]$SkipPhones,
  # Google Play track for this release instead of mobile/store.json's android.track.
  [string]$PlayTrack = '',
  # How long to wait for each build, finalize and the TestFlight build.
  [int]$WaitMinutes = 60,
  # How long the check phase waits for CI that is still running on HEAD.
  [int]$CiWaitMinutes = 30
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$repo = 'quikmn/iskra-voice'
$started = Get-Date
$runs = [ordered]@{}
# Nothing may wait for a person: gh and git fail instead of asking.
$env:GH_PROMPT_DISABLED = '1'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
# One SimplySign auto-login per release run: the login script keys its one attempt on this (steps inherit it).
if (-not $env:ISKRA_RELEASE_RUN) { $env:ISKRA_RELEASE_RUN = [guid]::NewGuid().ToString('N') }
Import-Module (Join-Path $PSScriptRoot 'release-checks.psm1') -Force

function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "ok: $text" -ForegroundColor Green }
function Info([string]$text) { Write-Host $text }
function Warn([string]$text) { Write-Host "warning: $text" -ForegroundColor Yellow }
function Stop-At([string]$case, [string]$todo) {
  Write-Host ''
  Write-Host "STOP [$case] $todo" -ForegroundColor Red
  exit 1
}
# Check phase: red findings are collected and listed together when the phase ends.
$script:reds = [System.Collections.Generic.List[string]]::new()
function Red([string]$case, [string]$todo) {
  $script:reds.Add("[$case] $todo")
  Write-Host "red: [$case] $todo" -ForegroundColor Red
}
function End-Checks([string]$what) {
  Write-Host ''
  if ($script:reds.Count) {
    Write-Host "$($script:reds.Count) thing(s) to fix before $what (nothing was changed or sent):" -ForegroundColor Red
    foreach ($r in $script:reds) { Write-Host "  - $r" -ForegroundColor Red }
    Write-Host 'Fix them, then run the same command again.'
    exit 1
  }
  if ($CheckOnly) {
    Write-Host "ALL CHECKS GREEN: $what would go ahead. Nothing was changed (check only)." -ForegroundColor Green
    exit 0
  }
  Write-Host '================================================' -ForegroundColor Green
  Write-Host "  ALL CHECKS GREEN - SENDING ($what)" -ForegroundColor Green
  Write-Host '================================================' -ForegroundColor Green
}
# Runs a native command, shows its output, and returns it (lines) with the exit code in $script:code.
function Run([string]$exe, [string[]]$arguments) {
  $out = & $exe @arguments 2>&1 | ForEach-Object { "$_" }
  $script:code = $LASTEXITCODE
  foreach ($l in $out) { Write-Host "  $l" }
  return , @($out)
}
# The same without showing the output.
function Quiet([string]$exe, [string[]]$arguments) {
  $out = & $exe @arguments 2>&1 | ForEach-Object { "$_" }
  $script:code = $LASTEXITCODE
  return , @($out)
}
function Gh-Json([string[]]$arguments) {
  $text = & gh @arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($text | Out-String | ConvertFrom-Json)
}
function Get-Text([string]$url) {
  try { return (Invoke-WebRequest -Uri $url -TimeoutSec 30 -Headers @{ 'Cache-Control' = 'no-cache' }).Content } catch { return $null }
}
# The red/warn/ok lines of scripts/release-preflight.mjs.
function Preflight([string[]]$arguments, [string]$case) {
  $out = Quiet node (@('scripts/release-preflight.mjs') + $arguments)
  foreach ($l in $out) {
    if ($l -match '^red: (.*)$') { Red $case $Matches[1] }
    elseif ($l -match '^warn: (.*)$') { Warn $Matches[1] }
    elseif ($l -match '^ok: (.*)$') { Ok $Matches[1] }
    elseif ($l) { Info "  $l" }
  }
}
function Latest-Tag { gh release view -R $repo --json tagName --jq .tagName 2>$null }
function Asset-Names([string]$t) { @((Gh-Json @('release', 'view', $t, '-R', $repo, '--json', 'assets')).assets | ForEach-Object name) }

# ── Checks ──
# Tools, gh and GitHub: these stop at once (nothing else can be checked without them).
function Check-Basics {
  foreach ($tool in 'git', 'gh', 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-At 'missing tool' "$tool isn't installed or not on PATH." }
  }
  gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { Stop-At 'gh not logged in' 'The GitHub CLI is not logged in: the human runs gh auth login.' }
  $script:remoteMain = ((git ls-remote origin refs/heads/main) -split '\s+')[0]
  if (-not $script:remoteMain) { Stop-At 'offline' "Couldn't reach GitHub (git ls-remote origin). Check the connection and run this again." }
  Ok 'tools there, gh logged in, GitHub reachable'
}
function Check-Workflows([string[]]$files) {
  $off = @()
  foreach ($wf in $files) {
    $state = gh api "repos/$repo/actions/workflows/$wf" --jq .state 2>$null
    if ($state -ne 'active') { $off += "$wf ($state)" }
  }
  if ($off.Count) { Red 'workflow off' "Not active on GitHub: $($off -join ', '). Enable it under Actions, or report it to the human." }
  else { Ok "workflows active: $($files -join ', ')" }
}
# On main, clean, exactly at origin/main (what ships must have passed CI), and git can push without asking.
function Check-Main([string[]]$allowDirty = @()) {
  $branch = git rev-parse --abbrev-ref HEAD
  if ($branch -ne 'main') { Red "you're on $branch" "Ship from main: git checkout main. Don't discard anything." }
  $dirty = @(git status --porcelain --untracked-files=all | Where-Object { $_ } | Where-Object { $allowDirty -notcontains $_.Substring(3).Replace('\', '/') })
  if ($dirty.Count) { Red 'working tree has changes' "Commit and push them, or discard them (report the files to the human): $($dirty -join '; ')" }
  $head = git rev-parse HEAD
  if ($head -ne $script:remoteMain) {
    git merge-base --is-ancestor $script:remoteMain HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { Red 'main is behind origin/main' 'git pull --ff-only, then run this again.' }
    else { Red 'main is ahead of origin/main' "$(git rev-list --count "$($script:remoteMain)..HEAD") local commit(s) aren't on GitHub: push main and let CI pass first." }
  } else { Ok "HEAD is at origin/main ($($head.Substring(0, 12)))" }
  $null = Quiet git @('push', '--dry-run', '--porcelain', 'origin', 'HEAD:refs/heads/main')
  if ($script:code -ne 0) { Red 'git cannot push' 'git push --dry-run origin main failed without asking: log git in to GitHub (gh auth setup-git), then run this again.' }
}
# CI must have passed on HEAD; while it runs, wait up to -CiWaitMinutes. Called last, after the quick checks.
function Check-CI {
  $head = git rev-parse HEAD
  if ($head -ne $script:remoteMain) { return }
  # CI skips pushes that only touch *.md and site/ (ci.yml paths-ignore): gate on the newest commit CI ran on or will run on.
  $sha = $head
  foreach ($c in @(git rev-list --first-parent -n 30 HEAD)) {
    $sha = $c
    if ([int](gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$c&event=push&per_page=1" --jq .total_count 2>$null) -gt 0) { break }
    if (@(git diff-tree --no-commit-id --name-only -r $c | Where-Object { $_ -notmatch '\.md$' -and $_ -notmatch '^site/' }).Count) { break }
  }
  $what = if ($sha -eq $head) { 'HEAD' } else { "$($sha.Substring(0, 12)) (the newer commits only change docs or site/, which CI skips)" }
  Info "CI on $what (waits up to $CiWaitMinutes min while it runs):"
  $out = Quiet node @('scripts/ci-gate.mjs', $sha, '--repo', $repo, '--wait-minutes', "$CiWaitMinutes")
  $url = ([regex]::Match(($out -join "`n"), 'https://github\.com/\S+/actions/runs/\d+')).Value
  $id = ($url -split '/')[-1]
  if ($script:code -eq 0) { Ok "CI passed on $what" }
  elseif (($out -join "`n") -match 'CI concluded (\w+)') { Red 'CI failed on main' "CI concluded $($Matches[1]): $url. Fix main first (gh run view $id -R $repo --log-failed). A flake: gh run rerun $id -R $repo --failed, then run this again." }
  else { Red 'CI not done' "No green CI run on $what after $CiWaitMinutes minutes$(if ($url) { " ($url)" }). Run this again when it's done (or with -CiWaitMinutes 60)." }
}
# Reviewers on an environment make a run wait for a click in GitHub: warn once, with the setting to change.
function Warn-Reviewers([string[]]$names) {
  foreach ($n in $names) {
    $rules = gh api "repos/$repo/environments/$n" --jq '[.protection_rules[]?.type] | join(",")' 2>$null
    if ($rules -match 'required_reviewers') { Warn "environment `"$n`" has required reviewers, so its runs wait for an approval: GitHub → $repo → Settings → Environments → $n → untick `"Required reviewers`" → Save protection rules" }
  }
}
# SimplySign: a test signature; when it isn't logged in and a seed is stored (scripts/simplysign-setup.ps1) it logs
# itself in once (scripts/simplysign-login.ps1). Still not logged in: stops at once with one line.
function Check-Signing {
  $s = Confirm-Signing
  if (-not $s.Ok) { Stop-At 'SimplySign' $s.Message }
  Ok $s.Message
  if ($s.ExpiresSoon) { Warn "the code-signing certificate expires on $($s.Certificate.NotAfter.ToString('yyyy-MM-dd')): renew it (docs/ci-cd.md, Windows code signing)." }
}
function Check-Android {
  $problems = @(Get-AndroidProblems -DevRoot (Get-DevRoot -Repo $root))
  foreach ($p in $problems) { Red 'Android build' $p }
  if (-not $problems.Count) { Ok 'Android JDK, SDK and release keystore are there (presence only)' }
}
# mobile/store.json and the Play key (presence only); the GitHub names come from Preflight github.
function Check-Phones {
  Preflight @('store') 'store setup'
  $out = Quiet node (@('scripts/play-upload.mjs', $Version, '--check') + $(if ($PlayTrack) { @('--track', $PlayTrack) } else { @() }))
  if ($script:code -eq 2) { Red 'Google Play key' 'No Play service-account key at D:\Development_Projects\devkeys\google-play-service-account.json (docs/store/README.md, Google Play service account), or run with -SkipPhones.' }
  elseif ($script:code -ne 0) { Red 'Google Play' "scripts/play-upload.mjs --check: $(($out | Select-Object -Last 1) -replace '^Play upload stopped:\s*', '')" }
  else { Ok 'the Google Play key is there (presence only)' }
}

# ── Running workflows ──
# Starts a workflow_dispatch run and returns it (the first new run, with this title when given), or $null.
function Start-Workflow([string]$file, [string[]]$fields, [string]$title = '') {
  $since = (Get-Date).ToUniversalTime().AddSeconds(-10)
  $null = Run gh (@('workflow', 'run', $file, '-R', $repo) + @($fields | ForEach-Object { '-f', $_ }))
  if ($script:code -ne 0) { return $null }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 5
    $list = Gh-Json @('run', 'list', '-R', $repo, '--workflow', $file, '--event', 'workflow_dispatch', '-L', '10', '--json', 'databaseId,displayTitle,createdAt,url,status,conclusion')
    $run = @($list) | Where-Object { $_ -and ([datetime]$_.createdAt).ToUniversalTime() -ge $since -and (-not $title -or $_.displayTitle -eq $title) } | Select-Object -Last 1
    if ($run) { return $run }
  }
  return $null
}
# Waits for a run to complete (up to $minutes), asking every 15 s, and returns it with its jobs; $null at the deadline.
# With -Until, it returns as soon as those jobs (by name, or "<name> / …" for a called workflow's jobs) have completed
# while the rest of the run may still be going (Test-JobsDone, release-checks.psm1): finalize's "TestFlight groups and
# reviews" waits for Apple's processing, and nothing here needs it.
function Wait-Run($run, [int]$minutes, [string]$label, [string[]]$Until = @()) {
  $deadline = (Get-Date).AddMinutes($minutes)
  $fields = 'databaseId,status,conclusion,url,jobs'
  while ($run.status -ne 'completed') {
    if ($Until.Count -and $run.jobs -and (Test-JobsDone -Jobs @($run.jobs) -Names $Until)) { return $run }
    if ((Get-Date) -gt $deadline) { return $null }
    Start-Sleep -Seconds 15
    $now = Gh-Json @('run', 'view', "$($run.databaseId)", '-R', $repo, '--json', $fields)
    if ($now) {
      $run = $now
      Info "  $(Get-Date -Format HH:mm) $label $($run.status): $(@($run.jobs | Where-Object status -eq 'completed').Count) of $(@($run.jobs).Count) jobs done"
    }
  }
  return (Gh-Json @('run', 'view', "$($run.databaseId)", '-R', $repo, '--json', $fields))
}
function Failed-Jobs($run) { (@($run.jobs | Where-Object { $_.conclusion -notin 'success', 'skipped' } | ForEach-Object name) -join ', ') }
# What finalize's "TestFlight upload" job did: uploaded, failed, running, skipped (finalize with testflight off) or none
# (no such job: an older finalize, or no run at all).
function TestFlight-State($run) {
  if (-not $run) { return 'none' }
  $job = @($run.jobs | Where-Object name -eq 'TestFlight upload') | Select-Object -First 1
  if (-not $job) { return 'none' }
  if ($job.status -ne 'completed') { return 'running' }
  if ($job.conclusion -eq 'success') { return 'uploaded' }
  if ($job.conclusion -eq 'skipped') { return 'skipped' }
  return 'failed'
}

$modes = @($Resume.IsPresent, [bool]$Redeploy, $BotSdk.IsPresent, $Phones.IsPresent, $GitHub.IsPresent) | Where-Object { $_ }
if ($modes.Count -gt 1) { Stop-At 'one mode at a time' 'Use one of -Resume, -Redeploy, -BotSdk, -Phones, -GitHub.' }

Push-Location $root
try {
  # ════════════════ Redeploy without a release ════════════════
  if ($Redeploy -eq 'checksums') {
    Step 'Checks: checksums and attestations again'
    Check-Basics
    Check-Workflows @('release-finalize.yml')
    $tag = if ($Version) { "v$($Version.TrimStart('v'))" } else { Latest-Tag }
    $rel = Gh-Json @('release', 'view', $tag, '-R', $repo, '--json', 'isDraft,assets')
    if (-not $rel) { Red 'no such release' "There's no release $tag on GitHub." }
    else {
      # The file list as it was at that tag (finalize checks out the tag too).
      $spec = (git show "${tag}:scripts/release-assets.json" 2>$null) | Out-String | ConvertFrom-Json
      $have = @($rel.assets | ForEach-Object name)
      $missing = @($spec.PSObject.Properties | Where-Object { $_.Name -ne '$comment' } | ForEach-Object { @($_.Value) } |
        ForEach-Object { $_.Replace('{v}', $tag.TrimStart('v')) } | Where-Object { $have -notcontains $_ })
      if ($missing.Count) { Red 'files missing on the release' "$tag lacks $($missing -join ', '). Report it; the human decides which build to upload." } else { Ok "every file is on $tag" }
    }
    Warn-Reviewers @('release')
    End-Checks "checksums for $tag"
    # Sums and attestations only: no deploys, and no second TestFlight upload.
    $run = Start-Workflow 'release-finalize.yml' @("tag=$tag", 'deploy=false', 'testflight=false')
    if (-not $run) { Stop-At 'finalize did not start' 'gh workflow run release-finalize.yml failed or no run appeared. Report it.' }
    Info "release-finalize.yml: $($run.url)"
    $run = Wait-Run $run 60 'finalize'
    if (-not $run) { Stop-At 'finalize still running' 'Not done after 60 minutes; check it again later.' }
    if ($run.conclusion -ne 'success') { Stop-At 'finalize failed' "Jobs: $(Failed-Jobs $run). Report: gh run view $($run.databaseId) -R $repo --log-failed" }
    Ok "SHA256SUMS.txt and attestations of $tag redone ($($run.url))"
    exit 0
  }
  if ($Redeploy) {
    Step "Checks: redeploy $Redeploy"
    Check-Basics
    Check-Workflows @('deploy.yml')
    $fromRef = $null
    switch ($Redeploy) {
      'site' {
        $fromRef = if ($Ref) { $Ref } else { 'main' }
        if ($fromRef -eq 'main') {
          git fetch --quiet origin main 2>$null
          if (git rev-list 'origin/main..HEAD' -- site 2>$null) { Red 'site changes not on GitHub' 'Your site/ commits are only local: push main first (the site deploys from GitHub).' }
        }
        $fields = @("ref=$fromRef", 'site=true')
      }
      'webapp' {
        $fromRef = if ($Ref) { $Ref } else { Latest-Tag }
        $fields = @("ref=$fromRef", 'webapp=true')
      }
      'server' {
        $v = if ($Version) { $Version.TrimStart('v') } else { "$(Latest-Tag)".TrimStart('v') }
        $rel = Gh-Json @('release', 'view', "v$v", '-R', $repo, '--json', 'isDraft,assets')
        if (-not $rel -or $rel.isDraft) { Red 'not a published release' "v$v isn't a published release; chat.iskra.foo only takes published ones." }
        elseif (@($rel.assets | ForEach-Object name) -notcontains 'SHA256SUMS.txt') { Red 'no SHA256SUMS.txt' "v$v has no SHA256SUMS.txt: scripts/release.ps1 -Redeploy checksums $v first." }
        else { Ok "v$v is published with SHA256SUMS.txt" }
        $fields = @('ref=main', "server_version=$v")
      }
    }
    if ($fromRef) {
      if (-not (git ls-remote origin "refs/heads/$fromRef" "refs/tags/$fromRef")) { Red 'unknown ref' "'$fromRef' is neither a branch nor a tag on GitHub." } else { Ok "deploying from $fromRef" }
    }
    Warn-Reviewers @('release')
    End-Checks "redeploy $Redeploy"
    $run = Start-Workflow 'deploy.yml' $fields
    if (-not $run) { Stop-At 'deploy did not start' 'gh workflow run deploy.yml failed or no run appeared. Report it.' }
    Info "deploy.yml: $($run.url)"
    $run = Wait-Run $run 45 'deploy'
    if (-not $run) { Stop-At 'deploy still running' 'Not done after 45 minutes. Report it.' }
    if ($run.conclusion -ne 'success') {
      if ($Redeploy -eq 'server') { Stop-At 'deploy server failed' "Report the log (gh run view $($run.databaseId) -R $repo --log-failed). The server rolled back by itself; don't retry without the human." }
      Stop-At "deploy $Redeploy failed" "Jobs: $(Failed-Jobs $run). Run this once more; still failing: report gh run view $($run.databaseId) -R $repo --log-failed."
    }
    Ok "redeployed $Redeploy ($($run.url)); deploy.yml checked it is served"
    exit 0
  }

  # ════════════════ Bot SDK to npm ════════════════
  if ($BotSdk) {
    $pkgPath = 'bots/sdk/package.json'
    $current = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
    if (-not $Version) {
      if ($current -notmatch '^(\d+)\.(\d+)\.(\d+)$') { Stop-At 'not a version' "bots/sdk/package.json has '$current'; give the version." }
      $Version = "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { Stop-At 'not a version' "'$Version' isn't x.y.z." }
    $sdkTag = "bots-sdk-v$Version"
    Step "Checks: bot SDK $current -> $Version ($sdkTag)"
    Check-Basics
    Check-Workflows @('ci.yml', 'bots-sdk.yml')
    Check-Main
    if ([version]$Version -le [version]$current) { Red 'must be newer' "$Version isn't newer than $current." }
    if ((git tag --list $sdkTag) -or (git ls-remote --tags origin "refs/tags/$sdkTag")) { Red "tag $sdkTag already exists" 'Pick the next version. Never move tags.' }
    if (npm view "iskra-bots@$Version" version 2>$null) { Red 'already on npm' "iskra-bots $Version is already published; pick the next version." } else { Ok "iskra-bots $Version isn't on npm yet" }
    Push-Location bots
    try {
      if (Test-NodeModulesStale .) { $null = Quiet npm @('ci', '--no-audit', '--no-fund') }
      $out = Quiet npm @('run', 'typecheck')
      if ($script:code -ne 0) { Red 'bot SDK type-check' "npm run typecheck in bots/ fails: $(($out | Select-Object -Last 3) -join ' ')" } else { Ok 'the SDK and examples type-check' }
      $out = Quiet npm @('run', 'build:sdk')
      if ($script:code -ne 0) { Red 'bot SDK build' "npm run build:sdk fails: $(($out | Select-Object -Last 3) -join ' ')" }
      else {
        $out = Quiet npm @('pack', './sdk', '--dry-run')
        if ($script:code -ne 0) { Red 'bot SDK package' "npm pack ./sdk --dry-run fails: $(($out | Select-Object -Last 3) -join ' ')" } else { Ok 'the package builds and packs' }
      }
    } finally { Pop-Location }
    Warn-Reviewers @('npm')
    Check-CI
    End-Checks "bot SDK $Version"

    Step "Version $Version, commit, tag $sdkTag, push"
    $text = (Get-Content $pkgPath -Raw) -replace "(`"version`":\s*`")$([regex]::Escape($current))`"", "`${1}$Version`""
    [IO.File]::WriteAllText((Join-Path $root $pkgPath), $text)
    if ((Get-Content $pkgPath -Raw | ConvertFrom-Json).version -ne $Version) { Stop-At 'version bump failed' "Couldn't set the version in $pkgPath; nothing was committed. Report it." }
    $null = Run git @('commit', '--quiet', '-m', "Bot SDK $Version", '-m', 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', '--', $pkgPath)
    if ($script:code -ne 0) { Stop-At 'commit failed' 'See above; nothing was pushed.' }
    $null = Run git @('tag', '-a', $sdkTag, '-m', "Iskra bot SDK $Version")
    $null = Run git @('push', '--atomic', 'origin', 'main', $sdkTag)
    if ($script:code -ne 0) { Stop-At 'git push rejected' 'Report the output above. Never force. The commit and tag stay local; the human decides.' }
    Ok "pushed main and $sdkTag"
    Step 'Publishing (bots-sdk.yml)'
    $run = $null
    $deadline = (Get-Date).AddMinutes(5)
    while (-not $run -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 10
      $run = @(Gh-Json @('run', 'list', '-R', $repo, '--workflow', 'bots-sdk.yml', '--branch', $sdkTag, '-L', '3', '--json', 'databaseId,status,conclusion,url')) | Where-Object { $_ } | Select-Object -First 1
    }
    if (-not $run) { Stop-At 'bots-sdk.yml did not start' "No run for $sdkTag after 5 minutes. Report it." }
    Info "bots-sdk.yml: $($run.url)"
    $done = Wait-Run $run 30 'bots-sdk'
    if (-not $done -or $done.conclusion -ne 'success') { Stop-At 'npm publish failed' "Report: gh run view $($run.databaseId) -R $repo --log-failed. Don't move the tag; the next try is the next version." }
    $onNpm = $null
    for ($i = 0; $i -lt 10 -and $onNpm -ne $Version; $i++) { if ($i) { Start-Sleep -Seconds 15 }; $onNpm = npm view "iskra-bots@$Version" version 2>$null }
    if ($onNpm -ne $Version) { Stop-At 'not on npm yet' "bots-sdk.yml succeeded but npm doesn't list iskra-bots $Version yet. Check https://www.npmjs.com/package/iskra-bots in a few minutes." }
    Ok "iskra-bots $Version is on npm, with provenance"
    exit 0
  }

  # ════════════════ The Release workflow on GitHub (the button) ════════════════
  if ($GitHub) {
    Step "Checks: the Release workflow on GitHub$(if ($Version) { " ($Version)" })"
    Check-Basics
    Check-Workflows @('release-all.yml')
    # The home PC's runner must be online (only the owner's gh can see runners).
    $states = @(Gh-Json @('api', "repos/$repo/actions/runners") | ForEach-Object { $_.runners } |
      Where-Object { @($_.labels | ForEach-Object name) -contains 'iskra-windows-signing' } | ForEach-Object status)
    if (-not $states.Count) { Red 'no home PC runner' 'No runner has the label iskra-windows-signing: run scripts/runner-setup.ps1 once on the home PC (docs/ci-cd.md, "The home PC runner").' }
    elseif ($states -notcontains 'online') { Red 'home PC offline' 'The home PC runner is offline: switch the PC on and log in to Windows (the runner starts at logon).' }
    else { Ok 'the home PC runner is online' }
    $policy = gh api "repos/$repo/actions/permissions/fork-pr-contributor-approval" --jq .approval_policy 2>$null
    if ($policy -and $policy -ne 'all_external_contributors') { Red 'Actions setting' 'GitHub -> Settings -> Actions -> General -> "Approval for running fork pull request workflows from contributors": pick "Require approval for all external contributors" (the repo has a self-hosted runner).' }
    if ($script:reds.Count) { End-Checks 'a Release run on GitHub' }
    $fields = @("version=$Version", "phones=$((-not $SkipPhones).ToString().ToLowerInvariant())", "check_only=$($CheckOnly.IsPresent.ToString().ToLowerInvariant())")
    Step "Starting the Release workflow$(if ($CheckOnly) { ' (checks only)' })"
    $run = Start-Workflow 'release-all.yml' $fields
    if (-not $run) { Stop-At 'Release did not start' "gh workflow run release-all.yml failed or no run appeared. Check: gh run list -R $repo --workflow release-all.yml -L 3" }
    Info "Release: $($run.url)"
    $run = Wait-Run $run ($WaitMinutes + 120) 'Release'
    if (-not $run) { Stop-At 'Release still running' "Not done yet; follow it on GitHub: gh run watch -R $repo" }
    if ($run.conclusion -ne 'success') { Stop-At "Release $($run.conclusion)" "Jobs: $(Failed-Jobs $run). The run's summary says what to fix ($($run.url)); gh run view $($run.databaseId) -R $repo --log-failed" }
    Ok "the Release workflow succeeded$(if ($CheckOnly) { ' (checks only: nothing was changed)' }): $($run.url)"
    exit 0
  }

  # ════════════════ Release, -Resume, -Phones ════════════════
  if (-not $Version) {
    if ($Phones) { $Version = "$(Latest-Tag)".TrimStart('v') }
    elseif ($Resume) { $Version = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version }
    else {
      $Version = (& node scripts/release-preflight.mjs next-version --repo $repo 2>&1 | Select-Object -Last 1) -replace '^red: ', ''
      if ($LASTEXITCODE -ne 0) { Stop-At 'which version?' $Version }
      Info "Version: $Version (the next alpha after the latest release)"
    }
  }
  if ($Version -notmatch '^\d+\.\d+\.\d+(-alpha\.\d+)?$') { Stop-At 'not a version' "'$Version' isn't a release version (x.y.z or x.y.z-alpha.n, no leading v)." }
  $tag = "v$Version"
  $store = $null
  try { $store = Get-Content mobile/store.json -Raw | ConvertFrom-Json } catch { }
  $githubArgs = @('github') + $(if ($SkipPhones) { @('--skip-phones') } else { @() })

  if ($Phones) {
    Step "Checks: phone apps of $tag"
    Check-Basics
    Check-Workflows @('mobile-ios.yml')
    $rel = Gh-Json @('release', 'view', $tag, '-R', $repo, '--json', 'isDraft')
    if (-not $rel -or $rel.isDraft) { Red 'not published' "$tag isn't a published release; the phones follow a published release." } else { Ok "$tag is published" }
    if (-not (Test-Path (Join-Path $root "mobile\release\Iskra-$Version.aab"))) {
      if ((git describe --tags --exact-match 2>$null) -ne $tag) { Red 'Android app bundle' "mobile\release\Iskra-$Version.aab isn't there and HEAD isn't $tag to build it: git checkout $tag, then run this again." }
      else { Check-Android }
    }
    Check-Phones
    Preflight $githubArgs 'GitHub setup'
    End-Checks "the phone apps of $tag"
  } elseif ($Resume) {
    Step "Checks: resume $tag"
    Check-Basics
    if (-not (git tag --list $tag) -or -not (git ls-remote --tags origin "refs/tags/$tag")) { Stop-At 'nothing to resume' "Tag $tag isn't both here and on GitHub. Run without -Resume." }
    $head = git rev-parse HEAD
    if ($head -ne (git rev-parse --verify --quiet "$tag^{commit}")) { Stop-At "HEAD isn't the $tag commit" "git checkout $tag (or git checkout main if main is still at it), then -Resume again." }
    $names = Asset-Names $tag
    if (@(& node scripts/release-assets.mjs list $Version windows android | Where-Object { $_ -and ($names -notcontains $_) }).Count) { Check-Signing; Check-Android }
    Check-Workflows (@('release.yml', 'release-finalize.yml', 'deploy.yml') + $(if ($SkipPhones) { @() } else { @('mobile-ios.yml') }))
    if (-not $SkipPhones) { Check-Phones }
    Preflight $githubArgs 'GitHub setup'
    Ok "resuming $tag at $($head.Substring(0, 12))"
    End-Checks "resuming $tag"
  } else {
    Step "Checks: release $tag"
    # SimplySign first: the quickest red, and the one a person has to fix by hand.
    Check-Signing
    Check-Basics
    Check-Workflows (@('ci.yml', 'release.yml', 'release-finalize.yml', 'deploy.yml') + $(if ($SkipPhones) { @() } else { @('mobile-ios.yml') }))
    Check-Main @("docs/releases/$Version.md", 'docs/releases/NEXT.md')
    if ((git tag --list $tag) -or (git ls-remote --tags origin "refs/tags/$tag")) { Red "tag $tag already exists" 'Pick the next version. Never move tags. (If this release was started already: -Resume.)' }
    gh release view $tag -R $repo *> $null
    if ($LASTEXITCODE -eq 0) { Red "a release $tag already exists" 'Report it to the human (a draft without a tag?).' }
    $current = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version
    node --input-type=module -e "import { compareVersions } from './scripts/release-lib.mjs'; process.exit(compareVersions(process.argv[1], process.argv[2]) > 0 ? 0 : 1)" $Version $current
    if ($LASTEXITCODE -ne 0) { Red 'must be newer than the current version' "$Version isn't newer than $current." } else { Ok "$current -> $Version" }

    # Release notes, the version strings in links.ts and the site, the release's file list.
    $out = Quiet node @('scripts/release-notes.mjs', $Version, '--dry-run')
    if ($script:code -ne 0) {
      $msg = ($out | Where-Object { $_ -like 'Release stopped:*' } | Select-Object -First 1) -replace '^Release stopped:\s*', ''
      Red 'write the release notes first' "$("$msg".TrimEnd('.')). Add the changes to docs/releases/NEXT.md (or write docs/releases/$Version.md; docs/releases/README.md); never invent notes."
    } else { Ok 'release notes are ready' }
    $out = Quiet node @('scripts/release-version.mjs', $Version, '--dry-run')
    if ($script:code -ne 0) {
      $msg = ($out | Where-Object { $_ -like 'Release stopped:*' } | Select-Object -First 1) -replace '^Release stopped:\s*', ''
      Red "doesn't mention the current version" "$("$msg".TrimEnd('.')). links.ts or site/index.html is out of sync with desktop/package.json."
    } else {
      $siteLine = $out | Where-Object { $_ -match 'site/index\.html: (\d+) occurrence' } | Select-Object -First 1
      $linksLine = $out | Where-Object { $_ -match 'client/src/links\.ts: (\d+) occurrence' } | Select-Object -First 1
      if (-not $siteLine -or [int]([regex]::Match($siteLine, '(\d+) occurrence').Groups[1].Value) -lt 20) { Red 'site download section' "site/index.html has fewer than 20 links to $current ($siteLine). Fix its download section." }
      elseif (-not $linksLine) { Red 'links.ts' "client/src/links.ts doesn't carry $current." }
      else { Ok "desktop/package.json, client/src/links.ts and site/index.html all say $current" }
    }
    $assets = @(& node scripts/release-assets.mjs list $Version)
    $listed = $LASTEXITCODE
    $spec = Get-Content scripts/release-assets.json -Raw | ConvertFrom-Json
    $want = @($spec.PSObject.Properties | Where-Object { $_.Name -ne '$comment' } | ForEach-Object { @($_.Value) }).Count
    if ($listed -ne 0 -or $assets.Count -ne $want -or $assets.Count -lt 20) { Red 'release file list' "scripts/release-assets.mjs lists $($assets.Count) files, scripts/release-assets.json has $want. Report it." }
    else { Ok "the release will carry $($assets.Count) files (scripts/release-assets.json)" }

    # What the Windows step builds with (it runs after the tag is pushed).
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { Red 'missing tool' 'dotnet (the .NET 10 SDK) builds the server: install it.' }
    if (-not (Test-Path '.tools\livekit-server.exe') -and -not (Test-Path '.tools\win-x64\livekit-server.exe')) { Red 'LiveKit missing' 'The Windows server bundles .tools\livekit-server.exe: run scripts/get-livekit.ps1.' }
    $free = (Get-PSDrive -Name ($root.Substring(0, 1)) -ErrorAction SilentlyContinue).Free
    if ($free -and $free -lt 10GB) { Red 'disk space' "Only $([int]($free / 1GB)) GB free on $($root.Substring(0, 2)); the builds need about 10 GB." }
    Check-Android
    if (-not $SkipPhones) { Check-Phones }
    Preflight $githubArgs 'GitHub setup'
    Check-CI
    End-Checks "release $tag"

    # ── 1. Release notes ──
    Step 'Release notes'
    $null = Run node @('scripts/release-notes.mjs', $Version)
    if ($script:code -ne 0) { Stop-At 'release notes' 'scripts/release-notes.mjs stopped (see above). Nothing was committed or pushed.' }

    # ── 2. Version bump, links.ts, site download section, commit and tag ──
    Step 'Version bump (desktop/package.json, client/src/links.ts, site/index.html), commit and tag'
    $out = Run node @('scripts/release-version.mjs', $Version)
    if ($script:code -ne 0 -or -not ($out -match "tagged $([regex]::Escape($tag))")) { Stop-At 'version bump failed' 'scripts/release-version.mjs stopped (see above). Report the exact message; nothing was pushed.' }
    Ok "committed Version $Version and tagged $tag"

    # ── 3. Push: release.yml (Linux, macOS, SBOMs) and mobile-ios.yml (the iPhone build) start on the tag right away;
    #       CI runs on main in parallel (finalize checks it) ──
    Step "Push main and $tag"
    $null = Run git @('push', '--atomic', 'origin', 'main', $tag)
    if ($script:code -ne 0) { Stop-At 'git push rejected' 'Report the output above. Never force. The commit and tag stay local; the human decides.' }
    Ok "pushed main and $tag"
    # The draft release now, before any build finishes: release.yml's jobs and the Windows step upload straight to it
    # (a job that finds none makes it; one made here can't be made twice by two jobs finishing at the same moment).
    gh release view $tag -R $repo *> $null
    if ($LASTEXITCODE -ne 0) {
      $null = Run gh @('release', 'create', $tag, '-R', $repo, '--draft', '--prerelease', '--verify-tag', '--title', "Iskra $Version", '--notes', 'Builds follow.')
      if ($script:code -ne 0) { Warn "couldn't create the draft release $tag now; the first build to finish makes it." } else { Ok "draft release $tag created" }
    }
  }

  if (-not $Phones) {
    # ── 4. Windows apps, server zip and Android APK (SimplySign) ──
    Step 'Windows step (scripts/release-windows.ps1: signed Windows apps, server zip, Android APK)'
    $names = Asset-Names $tag
    if (-not @(& node scripts/release-assets.mjs list $Version windows android | Where-Object { $_ -and ($names -notcontains $_) }).Count) {
      Ok 'the Windows and Android files are already on the release'
    } else {
      $log = Join-Path ([IO.Path]::GetTempPath()) "iskra-release-windows-$Version.log"
      & pwsh -NoProfile -NonInteractive -File scripts/release-windows.ps1 $Version *>&1 | Tee-Object -FilePath $log | ForEach-Object { Write-Host "  $_" }
      if ($LASTEXITCODE -ne 0) {
        $msg = ([regex]::Match((Get-Content $log -Raw), 'Release stopped: ([^\r\n]+)')).Groups[1].Value
        # Unsigned files or a failed signature mean SimplySign logged out during the build; anything else is a bad signature.
        if ($msg -match "SimplySign|isn't validly signed \(NotSigned") { Stop-At 'SimplySign' ((Get-SimplySignLoginLine) -replace 'run scripts/release\.ps1 again', 'run scripts/release.ps1 -Resume') }
        if ($msg -match "isn't validly signed|has no timestamp|is signed by '") { Stop-At 'bad signature' "$msg Don't upload; report it." }
        if ($msg -match 'expired') { Stop-At 'certificate expired' "$msg See docs/ci-cd.md, Windows code signing." }
        if ($msg -match "build-android.ps1 didn't produce|android-sdk|JDK|assetlinks") { Stop-At 'Android build failed' "$msg Report it; never try another keystore." }
        Stop-At 'Windows step failed' "release-windows.ps1: $msg (log: $log). Report it."
      }
      Ok 'Windows files built, signed, uploaded and checked'
    }

    # ── 5. Linux and macOS builds (release.yml, started by the tag) ──
    Step 'Linux and macOS builds (release.yml)'
    $deadline = (Get-Date).AddMinutes($WaitMinutes)
    $run = $null
    while (-not $run) {
      $list = Gh-Json @('run', 'list', '-R', $repo, '--workflow', 'release.yml', '--branch', $tag, '-L', '5', '--json', 'databaseId,status,conclusion,url,event')
      $run = @($list) | Where-Object { $_ -and $_.event -eq 'push' } | Select-Object -First 1
      if (-not $run) {
        if ((Get-Date) -gt $deadline) { Stop-At 'release.yml failed' "No release.yml run for $tag after $WaitMinutes minutes. Report it (gh run list -R $repo --workflow release.yml -L 3)." }
        Start-Sleep -Seconds 15
      }
    }
    $runs['release.yml'] = $run.url
    Info "release.yml: $($run.url)"
    $run = Wait-Run $run ([math]::Max(1, [int]($deadline - (Get-Date)).TotalMinutes)) 'release.yml'
    if (-not $run) { Stop-At 'release.yml still running' "Not done after $WaitMinutes minutes. When it's done: scripts/release.ps1 -Resume" }
    if ($run.conclusion -ne 'success') { Stop-At 'release.yml failed' "Jobs: $(Failed-Jobs $run). Report: gh run view $($run.databaseId) -R $repo --log-failed (first 40 lines). Stop." }
    $runLog = gh run view "$($run.databaseId)" -R $repo --log 2>$null | Out-String
    $notarized = ([regex]::Matches($runLog, 'notarization successful')).Count
    $teams = ([regex]::Matches($runLog, 'TeamIdentifier=')).Count
    if ($notarized -lt 2 -or $teams -lt 2) { Stop-At 'Mac builds not notarized' "release.yml shows $notarized 'notarization successful' and $teams 'TeamIdentifier=' lines (2 each expected): installed Mac apps won't update to this release. Report it; don't finalize." }
    Ok 'release.yml succeeded; both Mac builds signed and notarized'

    # ── 6. Every file on the release ──
    Step 'Release files'
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "iskra-names-$Version.txt"
    Asset-Names $tag | Set-Content -Path $tmp -Encoding utf8
    $null = Run node @('scripts/release-assets.mjs', 'names', $Version, $tmp)
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ($script:code -ne 0) { Stop-At 'files missing on the release' 'Report the missing names above. (A failed build: rerun its workflow, then -Resume.)' }

    # ── 7. Finalize: CI gate, checks, sums, attestations, publish, then the deploys and the TestFlight upload side by
    #       side. No approvals. Waits for publish, the deploys and the upload, not for "TestFlight groups and reviews"
    #       (Apple's processing, up to an hour; a failure there reaches the Iskra channel on its own). ──
    Step 'Release finalize (publish + deploy iskra.foo, app.iskra.foo, chat.iskra.foo + TestFlight upload)'
    $script:finalizeRun = $null
    $rel = Gh-Json @('release', 'view', $tag, '-R', $repo, '--json', 'isDraft,isPrerelease')
    if ($rel -and -not $rel.isDraft -and (Latest-Tag) -eq $tag) {
      Ok "$tag is already published as Latest; not finalizing again"
      # Its finalize run (titled "Release finalize vX"), for the TestFlight upload's result in step 8: the newest one
      # whose upload job ran (a checksums rerun skips it), else the newest.
      $earlier = @(Gh-Json @('run', 'list', '-R', $repo, '--workflow', 'release-finalize.yml', '-L', '20', '--json', 'databaseId,displayTitle')) |
        Where-Object { $_ -and $_.displayTitle -eq "Release finalize $tag" }
      foreach ($e in $earlier) {
        $view = Gh-Json @('run', 'view', "$($e.databaseId)", '-R', $repo, '--json', 'databaseId,status,conclusion,url,jobs')
        if (-not $view) { continue }
        if (-not $script:finalizeRun) { $script:finalizeRun = $view }
        if ((TestFlight-State $view) -notin 'none', 'skipped') { $script:finalizeRun = $view; break }
      }
    } else {
      $run = Start-Workflow 'release-finalize.yml' @("tag=$tag", "testflight=$((-not $SkipPhones).ToString().ToLowerInvariant())")
      if (-not $run) { Stop-At 'finalize did not start' "gh workflow run failed, or no new release-finalize.yml run after 2.5 minutes. Check: gh run list -R $repo --workflow release-finalize.yml -L 3" }
      $runs['release-finalize.yml'] = $run.url
      Info "release-finalize.yml: $($run.url)"
      $run = Wait-Run $run ($WaitMinutes + 45) 'finalize' -Until @('publish', 'deploy', 'TestFlight upload')
      if (-not $run) { Stop-At 'finalize still running' 'Not done yet. When it is: scripts/release.ps1 -Resume (phones and final checks).' }
      $script:finalizeRun = $run
      # The release itself: publish and the deploys. The TestFlight upload is a phone matter (step 8).
      $publish = @($run.jobs | Where-Object name -eq 'publish') | Select-Object -First 1
      $bad = @($run.jobs | Where-Object { ($_.name -eq 'publish' -or $_.name -like 'deploy / *') -and $_.conclusion -notin 'success', 'skipped' })
      if (-not $publish -or $bad.Count) {
        $failedStep = @($bad | ForEach-Object { $_.steps } | Where-Object conclusion -eq 'failure' | ForEach-Object name) | Select-Object -First 1
        $jobs = if ($bad.Count) { ($bad | ForEach-Object name) -join ', ' } else { "none ran ($($run.conclusion))" }
        switch -Regex ("$jobs | $failedStep") {
          'CI passed on the tagged commit' { Stop-At "CI didn't pass on $tag" 'Finalize refused: nothing was published. A flake: gh run rerun <id> --failed on that CI run, then scripts/release.ps1 -Resume. A real failure: fix main and release the next version; never move the tag.' }
          'Check every expected file' { Stop-At 'finalize: missing or mismatched files' "Report the log (gh run view $($run.databaseId) -R $repo --log-failed). The human decides which build to upload." }
          'site|webapp' { Stop-At 'deploy site/webapp check failed' "Jobs: $jobs. scripts/release.ps1 -Redeploy site (or webapp) once; still failing: report." }
          'server' { Stop-At 'deploy server failed' "Report the log (gh run view $($run.databaseId) -R $repo --log-failed). The server rolled back by itself; don't retry without the human." }
          default { Stop-At 'finalize failed' "Jobs: $jobs, step: $failedStep. Report: gh run view $($run.databaseId) -R $repo --log-failed" }
        }
      }
      Ok 'finalize succeeded (published, deployed)'
    }
  }

  # ── 8. Phones: iPhone/iPad to TestFlight (mobile-ios.yml on GitHub), Android to Google Play (from this PC) ──
  # Problems here are collected and reported after the final checks (the release itself is out by now).
  $phoneState = [ordered]@{}
  $script:phoneProblems = @()
  function Phone-Problem([string]$what, [string]$todo) { Write-Host "problem: $what. $todo" -ForegroundColor Yellow; $script:phoneProblems += "$what. $todo" }
  $trackName = if ($PlayTrack) { $PlayTrack } else { $store.android.track }
  $trackArgs = if ($PlayTrack) { @('--track', $PlayTrack) } else { @() }
  Step "Phones (iOS: $($store.ios.mode); Google Play track '$trackName')"
  if ($SkipPhones) {
    Info 'skipped (-SkipPhones)'
    $phoneState['Phones'] = 'skipped (-SkipPhones)'
  } else {
    $iosRun = $null
    if ($Phones) {
      # -Phones: the iPhone app is built again and uploaded by mobile-ios.yml itself (workflow_dispatch, upload on), the
      # fallback when finalize's upload didn't happen. Started now, waited for after the Android upload. A run of an
      # earlier attempt (same title) that succeeded or is still going is reused, so it never uploads the same build twice.
      $iosTitle = "Mobile iOS $tag (TestFlight)"
      $iosRuns = @(Gh-Json @('run', 'list', '-R', $repo, '--workflow', 'mobile-ios.yml', '-L', '30', '--json', 'databaseId,displayTitle,status,conclusion,url,createdAt')) |
        Where-Object { $_ -and $_.displayTitle -eq $iosTitle }
      $iosRun = @($iosRuns) | Where-Object { $_.status -ne 'completed' -or $_.conclusion -eq 'success' } | Select-Object -First 1
      if ($iosRun) {
        Info "TestFlight: using the earlier run for $tag ($($iosRun.status) $($iosRun.conclusion)): $($iosRun.url)"
      } else {
        $iosRun = Start-Workflow 'mobile-ios.yml' @("ref=$tag", 'upload=true') $iosTitle
        if (-not $iosRun) { Phone-Problem 'TestFlight build did not start' "gh workflow run mobile-ios.yml failed or no run appeared. Check: gh run list -R $repo --workflow mobile-ios.yml -L 3" }
        else { Info "TestFlight build: $($iosRun.url)" }
      }
      if ($iosRun) { $runs['mobile-ios.yml'] = $iosRun.url }
    } else {
      # A release: the tag push built the iPhone app (mobile-ios.yml) and finalize's "TestFlight upload" job uploaded it
      # (step 7). Anything else is reported after the Android upload; the fallback is -Phones.
      $tfRun = $script:finalizeRun
      $tfUrl = if ($tfRun) { " ($($tfRun.url))" } else { '' }
      switch (TestFlight-State $tfRun) {
        'uploaded' { Ok "uploaded to TestFlight by finalize$tfUrl; Apple processes it in 5-30 minutes, then finalize's TestFlight groups job does the rest"; $phoneState['TestFlight'] = 'uploaded' }
        'running' { Phone-Problem 'TestFlight upload still running' "finalize's TestFlight upload job isn't done$tfUrl. When it is: scripts/release.ps1 -Resume"; $phoneState['TestFlight'] = 'still running' }
        'failed' { Phone-Problem 'TestFlight upload failed' "finalize's TestFlight upload job failed${tfUrl}: gh run view $($tfRun.databaseId) -R $repo --log-failed (the Mobile iOS build of the tag, or the upload itself; the playbook's mobile-ios.yml rows). Then scripts/release.ps1 -Phones builds and uploads it again."; $phoneState['TestFlight'] = 'failed' }
        default { Phone-Problem 'TestFlight not uploaded' "finalize didn't upload the iPhone app$tfUrl (no TestFlight upload job ran: finalize with testflight off, or from before this pipeline). scripts/release.ps1 -Phones builds and uploads it."; $phoneState['TestFlight'] = 'not uploaded' }
      }
    }

    # Android: the app bundle from the Windows step (built with the APK), to Google Play's track.
    $aab = Join-Path $root "mobile\release\Iskra-$Version.aab"
    if (-not (Test-Path $aab)) {
      Info "$aab isn't there (the Windows step ran elsewhere?): building it now."
      & pwsh -NoProfile -NonInteractive -File mobile/scripts/build-android.ps1 *>&1 | ForEach-Object { Write-Host "  $_" }
    }
    if (-not (Test-Path $aab)) {
      Phone-Problem 'Android app bundle missing' "mobile/scripts/build-android.ps1 didn't produce $aab (see its output above). Report it; never try another keystore."
      $phoneState['Google Play'] = 'not uploaded (no app bundle)'
    } else {
      $out = Run node (@('scripts/play-upload.mjs', $Version) + $trackArgs)
      $last = $out | Select-Object -Last 1
      if ($script:code -eq 0) { Ok $last; $phoneState['Google Play'] = "on the '$trackName' track" }
      elseif ($script:code -eq 2) { Phone-Problem 'Google Play key missing' 'docs/store/README.md, Google Play service account; then -Resume.'; $phoneState['Google Play'] = 'skipped (no service-account key)' }
      else {
        Phone-Problem 'Google Play upload failed' "$($last -replace '^Play upload stopped:\s*', ''). See docs/ci-cd.md troubleshooting; then -Resume (a version already on the track is left alone)."
        $phoneState['Google Play'] = 'failed'
      }
    }

    # -Phones: wait for the iOS run: build, upload, Apple's processing, then the TestFlight groups and reviews (scripts/appstore.mjs).
    if ($iosRun) {
      $done = Wait-Run $iosRun ($WaitMinutes + 45) 'TestFlight build'
      if (-not $done) {
        Phone-Problem 'TestFlight build still running' "Not done after $($WaitMinutes + 45) minutes: $($iosRun.url). When it's done: scripts/release.ps1 -Resume"
        $phoneState['TestFlight'] = 'still running'
      } elseif ($done.conclusion -ne 'success') {
        Phone-Problem 'TestFlight build failed' "mobile-ios.yml $($done.conclusion): gh run view $($done.databaseId) -R $repo --log-failed. Playbook decision table (mobile-ios.yml rows); then -Resume starts a new build."
        $phoneState['TestFlight'] = 'failed'
      } else {
        Ok "uploaded to TestFlight ($($done.url)); Apple processes it in 5-30 minutes"
        $phoneState['TestFlight'] = 'uploaded'
      }
    }
  }
  $phonesLine = "Phones: $(($phoneState.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', ')"
  if ($Phones) {
    Write-Host ''
    Write-Host $phonesLine
    if ($script:phoneProblems.Count) { Stop-At 'phones' ($script:phoneProblems -join ' | ') }
    exit 0
  }

  # ── 9. Final checks ──
  Step 'Final checks'
  $site = Get-Text 'https://iskra.foo/'
  $siteVersion = if ($site) { ([regex]::Matches($site, 'releases/download/v([0-9A-Za-z.\-]+)/') | ForEach-Object { $_.Groups[1].Value } | Select-Object -First 1) } else { $null }
  # The bundler may quote the version with ', " or a backtick. Cloudflare can take a few minutes to serve the new
  # bundle, so ask again for up to 5 minutes.
  $appHas = $false
  for ($try = 0; $try -lt 10 -and -not $appHas; $try++) {
    if ($try) { Start-Sleep -Seconds 30 }
    $app = Get-Text 'https://app.iskra.foo/'
    $asset = if ($app) { ([regex]::Match($app, '/assets/index-[A-Za-z0-9_-]+\.js')).Value } else { $null }
    $appJs = if ($asset) { Get-Text "https://app.iskra.foo$asset" } else { $null }
    $appHas = [bool]($appJs -and (@("'", '"', [string][char]96) | Where-Object { $appJs.Contains("$_$Version$_") }))
  }
  $health = Get-Text 'https://chat.iskra.foo/health'
  $chatVersion = if ($health) { try { ($health | ConvertFrom-Json).version } catch { $null } } else { $null }
  $fails = @()
  $rel = Gh-Json @('release', 'view', $tag, '-R', $repo, '--json', 'isDraft,isPrerelease,assets')
  $latest = Latest-Tag
  if (-not $rel -or $rel.isDraft -or $rel.isPrerelease -or $latest -ne $tag) { $fails += "release: Latest is $latest, draft $($rel.isDraft), prerelease $($rel.isPrerelease)" } else { Ok "$tag is Latest" }
  $names = @($rel.assets | ForEach-Object name)
  $missing = @(& node scripts/release-assets.mjs list $Version | Where-Object { $_ -and ($names -notcontains $_) })
  if ($names -notcontains 'SHA256SUMS.txt') { $missing += 'SHA256SUMS.txt' }
  if ($missing.Count) { $fails += "files missing: $($missing -join ', ')" } else { Ok "all $($names.Count) files on the release, with SHA256SUMS.txt" }
  if ($siteVersion -ne $Version) { $fails += "iskra.foo links to $siteVersion" } else { Ok "iskra.foo links to $Version" }
  if (-not $appHas) { $fails += "app.iskra.foo's bundle ($asset) doesn't have $Version" } else { Ok "app.iskra.foo serves $Version" }
  if ($chatVersion -ne $Version) { $fails += "chat.iskra.foo runs $chatVersion" } else { Ok "chat.iskra.foo runs $Version" }
  # The phone apps aren't a final check (a problem there ends with STOP [phones] below), but the upload's result belongs here.
  if ($phoneState['TestFlight'] -eq 'uploaded') { Ok 'TestFlight upload ok (finalize)' }
  if ($fails.Count) { Stop-At 'final checks failed' "$($fails -join '; '). A site/web app check: scripts/release.ps1 -Redeploy site (or webapp) once. Otherwise report." }

  Write-Host ''
  Write-Host "Task: release $Version" -ForegroundColor Green
  Write-Host "Result: $(if ($script:phoneProblems.Count) { 'done, except the phone apps (below)' } else { 'done' })"
  Write-Host "Release: https://github.com/$repo/releases/tag/$tag"
  if ($runs.Count) { Write-Host "Runs: $(($runs.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', ')" }
  Write-Host "Checks: iskra.foo ok, app.iskra.foo ok, chat.iskra.foo ok, Latest = $tag yes"
  if ($phoneState.Count) { Write-Host $phonesLine }
  Write-Host "Took $([int]((Get-Date) - $started).TotalMinutes) min."
  if ($script:phoneProblems.Count) { Stop-At 'phones' "The release is out; the phone apps aren't all done: $($script:phoneProblems -join ' | ')" }
} finally { Pop-Location }
