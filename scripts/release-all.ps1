#Requires -Version 7
# A whole release in one command (docs/ci-cd-playbook.md, A): preflight, release notes, version bump and tag, push,
# the Windows build (SimplySign), the Linux/macOS builds, Release finalize (which refuses unless CI passed on the tag)
# with the deploys, and the final checks. Each problem prints one STOP line saying what it is and what to do, and ends.
#
#   .\scripts\release-all.ps1 2.0.0-alpha.14            # the release (SimplySign Desktop logged in)
#   .\scripts\release-all.ps1 2.0.0-alpha.14 -DryRun    # every check, every step printed; changes nothing
#   .\scripts\release-all.ps1 2.0.0-alpha.14 -Resume    # after a STOP once the tag is pushed: picks up where it ended
#
# Run it from main in D:\Development_Projects\Iskra. It never prints secrets, never moves tags, never force-pushes.
param(
  [Parameter(Mandatory)][string]$Version,
  [switch]$DryRun,
  [switch]$Resume,
  # How long to wait for the Linux and macOS builds and for finalize (each).
  [int]$WaitMinutes = 60
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tag = "v$Version"
$repo = 'quikmn/iskra-voice'
$started = Get-Date
$runs = [ordered]@{}

function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "ok: $text" -ForegroundColor Green }
function Info([string]$text) { Write-Host $text }
# One line per decision-table case, then the end of the run (exit 1).
function Stop-At([string]$case, [string]$todo) {
  Write-Host ''
  Write-Host "STOP [$case] $todo" -ForegroundColor Red
  exit 1
}
# Preflight problems: a real run stops; a dry run notes them and goes on, so it shows every problem at once.
$script:dryProblems = 0
function Problem([string]$case, [string]$todo) {
  if (-not $DryRun) { Stop-At $case $todo }
  $script:dryProblems++
  Write-Host "DRY RUN would stop [$case] $todo" -ForegroundColor Yellow
}
function Would([string]$text) { Write-Host "DRY RUN would: $text" -ForegroundColor Yellow }
# Runs a native command, shows its output, and returns it (lines) with the exit code in $script:code.
function Run([string]$exe, [string[]]$arguments) {
  $out = & $exe @arguments 2>&1 | ForEach-Object { "$_" }
  $script:code = $LASTEXITCODE
  foreach ($l in $out) { Write-Host "  $l" }
  return , @($out)
}
function Gh-Json([string[]]$arguments) {
  $text = & gh @arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($text | Out-String | ConvertFrom-Json)
}
function Release-Names {
  $r = Gh-Json @('release', 'view', $tag, '-R', $repo, '--json', 'assets')
  if (-not $r) { return @() }
  return @($r.assets | ForEach-Object name)
}
function Missing-Assets([string[]]$names, [string[]]$groups) {
  $want = & node scripts/release-assets.mjs list $Version @groups
  return @($want | Where-Object { $_ -and ($names -notcontains $_) })
}
function Get-Text([string]$url) {
  try { return (Invoke-WebRequest -Uri $url -TimeoutSec 30 -Headers @{ 'Cache-Control' = 'no-cache' }).Content } catch { return $null }
}

Push-Location $root
try {
  if ($DryRun) { Write-Host "Dry run for $tag`: checks everything, changes nothing (no files, commits, tags, pushes, uploads or workflow runs)." -ForegroundColor Yellow }

  # ── 1. Preflight ──
  Step "Preflight ($tag)"
  if ($Version -notmatch '^\d+\.\d+\.\d+(-alpha\.\d+)?$') { Stop-At 'not a version' "'$Version' isn't a release version (x.y.z or x.y.z-alpha.n, no leading v). Ask the human for the right version." }
  foreach ($tool in 'git', 'gh', 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-At 'missing tool' "$tool isn't installed or not on PATH." }
  }
  gh auth status *> $null
  if ($LASTEXITCODE -ne 0) { Stop-At 'gh not logged in' 'The GitHub CLI is not logged in: the human runs gh auth login.' }
  Ok 'gh is logged in'
  foreach ($wf in 'ci.yml', 'release.yml', 'release-finalize.yml', 'deploy.yml') {
    $state = gh api "repos/$repo/actions/workflows/$wf" --jq .state 2>$null
    if ($state -ne 'active') { Stop-At 'workflow off' "$wf isn't active on GitHub ($state). Report it to the human." }
  }
  Ok 'workflows ci, release, release-finalize and deploy are active'

  $remoteMain = ((git ls-remote origin refs/heads/main) -split '\s+')[0]
  if (-not $remoteMain) { Stop-At 'offline' "Couldn't reach GitHub (git ls-remote origin). Check the connection and run this again." }
  $localTag = git tag --list $tag
  $remoteTag = git ls-remote --tags origin "refs/tags/$tag"
  $head = git rev-parse HEAD

  if ($Resume) {
    if (-not $localTag -or -not $remoteTag) { Stop-At 'nothing to resume' "Tag $tag isn't both here and on GitHub. Start without -Resume." }
    $tagged = git rev-parse --verify --quiet "$tag^{commit}"
    if ($head -ne $tagged) { Stop-At "HEAD isn't the $tag commit" "Check it out: git checkout $tag (or git checkout main if main is still at it), then rerun with -Resume." }
    Ok "resuming $tag at $($head.Substring(0, 12))"
  } else {
    $branch = git rev-parse --abbrev-ref HEAD
    if ($branch -ne 'main') { Problem "you're on $branch" "Releases are made from main: git checkout main. Don't discard anything." }
    $dirty = @(git status --porcelain --untracked-files=all | Where-Object { $_ } | Where-Object {
        $p = $_.Substring(3).Replace('\', '/'); $p -ne "docs/releases/$Version.md" -and $p -ne 'docs/releases/NEXT.md' })
    if ($dirty.Count) { Problem 'working tree has changes' "Commit or discard them first (report the files to the human): $($dirty -join '; ')" }
    git merge-base --is-ancestor $remoteMain HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { Problem 'main is behind origin/main' 'git pull --ff-only, then run this again (once).' }
    else {
      $ahead = git rev-list --count "$remoteMain..HEAD"
      if ($ahead -ne '0') { Info "note: $ahead local commit(s) not on GitHub yet; they're pushed with the release and CI must pass on them before finalize publishes." }
    }
    if ($localTag -or $remoteTag) { Problem "tag $tag already exists" 'Ask the human for the next version. Never move tags. (If this release was started already: rerun with -Resume.)' }
    gh release view $tag -R $repo *> $null
    if ($LASTEXITCODE -eq 0 -and -not $remoteTag) { Problem "a release $tag already exists" 'Report it to the human (a draft without a tag?).' }
    $current = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version
    node --input-type=module -e "import { compareVersions } from './scripts/release-lib.mjs'; process.exit(compareVersions(process.argv[1], process.argv[2]) > 0 ? 0 : 1)" $Version $current
    if ($LASTEXITCODE -ne 0) { Problem 'must be newer than the current version' "$Version isn't newer than $current. Ask the human for the right version." }
    else { Ok "$current -> $Version" }

    # CI on main: red now means finalize would refuse later, so stop before tagging.
    if ($head -eq $remoteMain) {
      $gate = Run node @('scripts/ci-gate.mjs', $head, '--repo', $repo, '--wait-minutes', '0')
      if (($gate -join "`n") -match 'CI concluded') { Problem 'CI failed on main' "Finalize would refuse this commit. Report the failing run to the human (gh run view <id> --log-failed); release after main is green." }
      elseif ($script:code -ne 0) { Info 'note: CI on this commit is still running; finalize waits for it.' }
    } else {
      Info "note: CI hasn't run on the local commits yet; finalize waits for it after the push."
    }

    # ── 2. Release notes ──
    Step 'Release notes'
    $notesArgs = @('scripts/release-notes.mjs', $Version) + $(if ($DryRun) { @('--dry-run') } else { @() })
    $out = Run node $notesArgs
    if ($script:code -ne 0) {
      $msg = ($out | Where-Object { $_ -like 'Release stopped:*' } | Select-Object -First 1) -replace '^Release stopped:\s*', ''
      Problem 'write the release notes first' "$($msg.TrimEnd('.')). Write docs/releases/$Version.md from the human's notes (docs/releases/README.md), or fix NEXT.md; never invent notes."
    }

    # ── 3. Version bump, links.ts, site download section, commit and tag ──
    Step 'Version bump (desktop/package.json, client/src/links.ts, site/index.html), commit and tag'
    $out = Run node @('scripts/release.mjs', $Version, '--dry-run')
    if ($script:code -ne 0) {
      $msg = ($out | Where-Object { $_ -like 'Release stopped:*' } | Select-Object -First 1) -replace '^Release stopped:\s*', ''
      Problem "doesn't mention the current version" "$($msg.TrimEnd('.')). Report it: links.ts or site/index.html is out of sync with desktop/package.json."
    } else {
      $siteLine = $out | Where-Object { $_ -match 'site/index\.html: (\d+) occurrence' } | Select-Object -First 1
      if ($siteLine -and [int]([regex]::Match($siteLine, '(\d+) occurrence').Groups[1].Value) -lt 20) { Problem 'site download section' "site/index.html has fewer than 20 version links ($siteLine). Report it." }
    }
    if ($DryRun) {
      Would "node scripts/release.mjs $Version   (commit `"Version $Version`" with the notes, annotated tag $tag)"
    } else {
      $out = Run node @('scripts/release.mjs', $Version)
      if ($script:code -ne 0 -or -not ($out -match "tagged $([regex]::Escape($tag))")) { Stop-At 'version bump failed' "scripts/release.mjs stopped (see above). Report the exact message; nothing was pushed." }
      Ok "committed Version $Version and tagged $tag"
    }

    # ── 4. Push: release.yml starts on the tag right away; CI runs on main in parallel (finalize checks it) ──
    Step "Push main and $tag"
    if ($DryRun) { Would "git push --atomic origin main $tag" }
    else {
      $out = Run git @('push', '--atomic', 'origin', 'main', $tag)
      if ($script:code -ne 0) { Stop-At 'git push rejected' 'Report the output above. Never force. The commit and tag stay local; the human decides.' }
      Ok "pushed main and $tag"
    }
  }

  # ── 5. Windows apps, server zip and Android APK (SimplySign) ──
  Step 'Windows step (scripts/release-windows.ps1: signed Windows apps, server zip, Android APK)'
  $names = if ($DryRun) { @() } else { Release-Names }
  $winMissing = Missing-Assets $names @('windows', 'android')
  if ($DryRun) {
    $subject = 'Open Source Developer Viktor Lundgren'
    $cert = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
      Where-Object { $_.HasPrivateKey -and $_.Subject -like "*$subject*" } | Sort-Object NotAfter -Descending | Select-Object -First 1
    if ($cert) { Ok "code-signing certificate is in the store (valid until $($cert.NotAfter.ToString('yyyy-MM-dd')); SimplySign's login is tested by the real run)" }
    else { Info "note: no '$subject' certificate in the store now: log in to SimplySign Desktop before the real run." }
    Would "pwsh -NoProfile -File scripts/release-windows.ps1 $Version -NoFinalize   (build, sign, check signatures, upload $($winMissing.Count) files)"
  } elseif (-not $winMissing.Count) {
    Ok 'the Windows and Android files are already on the release'
  } else {
    Info 'Needs SimplySign Desktop logged in (6-digit code from the SimplySign app).'
    $log = Join-Path ([IO.Path]::GetTempPath()) "iskra-release-windows-$Version.log"
    & pwsh -NoProfile -File scripts/release-windows.ps1 $Version -NoFinalize *>&1 | Tee-Object -FilePath $log | ForEach-Object { Write-Host "  $_" }
    $code = $LASTEXITCODE
    if ($code -ne 0) {
      $text = Get-Content $log -Raw
      $msg = ([regex]::Match($text, 'Release stopped: ([^\r\n]+)')).Groups[1].Value
      if ($msg -match "SimplySign isn't logged in|signing failed during the build|isn't running") { Stop-At "SimplySign isn't logged in" "Ask the human to log in to SimplySign Desktop, then rerun once: .\scripts\release-all.ps1 $Version -Resume" }
      if ($msg -match "isn't validly signed|has no timestamp|is signed by '") { Stop-At 'bad signature' "$msg Don't upload; report it." }
      if ($msg -match 'expired') { Stop-At 'certificate expired' "$msg See docs/ci-cd.md, Windows code signing." }
      if ($msg -match "build-android.ps1 didn't produce|android-sdk|JDK|assetlinks") { Stop-At 'Android build failed' "$msg Report it; never try another keystore." }
      Stop-At 'Windows step failed' "release-windows.ps1: $msg (log: $log). Report it."
    }
    if ((Get-Content $log -Raw) -match 'expires on') { Info 'note: the code-signing certificate expires soon (see the warning above); report it.' }
    Ok 'Windows files built, signed, uploaded and checked'
  }

  # ── 6. Linux and macOS builds (release.yml, started by the tag) ──
  Step 'Linux and macOS builds (release.yml)'
  if ($DryRun) {
    Would "wait for release.yml on $tag (linux, mac (arm64), mac (x64) in parallel, then publish), up to $WaitMinutes min; check notarization ran for both Macs"
  } else {
    $deadline = (Get-Date).AddMinutes($WaitMinutes)
    $run = $null
    while (-not $run) {
      $list = Gh-Json @('run', 'list', '-R', $repo, '--workflow', 'release.yml', '--branch', $tag, '-L', '5', '--json', 'databaseId,status,conclusion,url,event')
      $run = @($list) | Where-Object { $_ -and $_.event -eq 'push' } | Select-Object -First 1
      if (-not $run) {
        if ((Get-Date) -gt $deadline) { Stop-At 'release.yml failed' "No release.yml run for $tag after $WaitMinutes minutes. Report it (gh run list -R $repo --workflow release.yml -L 3)." }
        Start-Sleep -Seconds 20
      }
    }
    $runs['release.yml'] = $run.url
    Info "release.yml: $($run.url)"
    while ($run.status -ne 'completed') {
      if ((Get-Date) -gt $deadline) { Stop-At 'release.yml still running' "Not done after $WaitMinutes minutes: $($run.url). When it's done: .\scripts\release-all.ps1 $Version -Resume" }
      Start-Sleep -Seconds 60
      $run = Gh-Json @('run', 'view', "$($run.databaseId)", '-R', $repo, '--json', 'databaseId,status,conclusion,url,jobs')
      $done = @($run.jobs | Where-Object status -eq 'completed').Count
      Info "  $(Get-Date -Format HH:mm) $($run.status): $done of $(@($run.jobs).Count) jobs done"
    }
    if ($run.conclusion -ne 'success') {
      $failed = @((Gh-Json @('run', 'view', "$($run.databaseId)", '-R', $repo, '--json', 'jobs')).jobs | Where-Object { $_.conclusion -notin 'success', 'skipped' } | ForEach-Object name) -join ', '
      Stop-At 'release.yml failed' "Jobs: $failed. Report: gh run view $($run.databaseId) -R $repo --log-failed (first 40 lines). Stop."
    }
    $log = gh run view "$($run.databaseId)" -R $repo --log 2>$null | Out-String
    $notarized = ([regex]::Matches($log, 'notarization successful')).Count
    $teams = ([regex]::Matches($log, 'TeamIdentifier=')).Count
    if ($notarized -lt 2 -or $teams -lt 2) { Stop-At 'Mac builds not notarized' "release.yml shows $notarized 'notarization successful' and $teams 'TeamIdentifier=' lines (2 each expected): installed Mac apps won't update to this release. Report it; don't finalize." }
    Ok "release.yml succeeded; both Mac builds signed and notarized"
  }

  # ── 7. Every file on the release ──
  Step 'Release files'
  if ($DryRun) {
    Would "check the $((& node scripts/release-assets.mjs list $Version).Count) expected files are on the $tag release (scripts/release-assets.mjs names)"
  } else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "iskra-names-$Version.txt"
    Release-Names | Set-Content -Path $tmp -Encoding utf8
    $out = Run node @('scripts/release-assets.mjs', 'names', $Version, $tmp)
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ($script:code -ne 0) { Stop-At 'files missing on the release' 'Report the missing names above. (A failed build: rerun its workflow or release-windows.ps1 -SkipBuild, then -Resume.)' }
  }

  # ── 8. Finalize: CI gate, checks, SBOMs, sums, attestations, publish, deploys ──
  Step 'Release finalize (publish + deploy iskra.foo, app.iskra.foo, chat.iskra.foo)'
  if ($DryRun) {
    Would "gh workflow run release-finalize.yml -R $repo -f tag=$tag; it waits for CI on the tagged commit (refuses unless green), then publishes and deploys; watch it up to $WaitMinutes min"
  } else {
    $rel = Gh-Json @('release', 'view', $tag, '-R', $repo, '--json', 'isDraft,isPrerelease')
    $latest = gh release view -R $repo --json tagName --jq .tagName 2>$null
    if ($rel -and -not $rel.isDraft -and $latest -eq $tag) {
      Ok "$tag is already published as Latest; not finalizing again"
    } else {
      $since = (Get-Date).ToUniversalTime().AddSeconds(-10)
      $null = Run gh @('workflow', 'run', 'release-finalize.yml', '-R', $repo, '-f', "tag=$tag")
      if ($script:code -ne 0) { Stop-At 'finalize did not start' 'gh workflow run failed (see above). Report it.' }
      $run = $null
      for ($i = 0; $i -lt 30 -and -not $run; $i++) {
        Start-Sleep -Seconds 5
        $list = Gh-Json @('run', 'list', '-R', $repo, '--workflow', 'release-finalize.yml', '--event', 'workflow_dispatch', '-L', '5', '--json', 'databaseId,createdAt,url,status')
        $run = @($list) | Where-Object { $_ -and ([datetime]$_.createdAt).ToUniversalTime() -ge $since } | Select-Object -Last 1
      }
      if (-not $run) { Stop-At 'finalize did not start' "No new release-finalize.yml run after 2.5 minutes. Check: gh run list -R $repo --workflow release-finalize.yml -L 3" }
      $runs['release-finalize.yml'] = $run.url
      Info "release-finalize.yml: $($run.url)"
      $deadline = (Get-Date).AddMinutes($WaitMinutes + 45)
      $asked = $false
      while ($run.status -ne 'completed') {
        if ($run.status -eq 'waiting' -and -not $asked) { Info "  The release environment asks for approval: approve it at $($run.url)"; $asked = $true }
        if ((Get-Date) -gt $deadline) { Stop-At 'finalize still running' "Not done: $($run.url). Watch it: gh run watch $($run.databaseId) -R $repo; then -Resume for the final checks." }
        Start-Sleep -Seconds 30
        $run = Gh-Json @('run', 'view', "$($run.databaseId)", '-R', $repo, '--json', 'databaseId,status,conclusion,url,jobs')
      }
      if ($run.conclusion -ne 'success') {
        $bad = @($run.jobs | Where-Object { $_.conclusion -notin 'success', 'skipped' })
        $step = @($bad | ForEach-Object { $_.steps } | Where-Object conclusion -eq 'failure' | ForEach-Object name) | Select-Object -First 1
        $jobs = ($bad | ForEach-Object name) -join ', '
        switch -Regex ("$jobs | $step") {
          'CI passed on the tagged commit' { Stop-At "CI didn't pass on $tag" "Finalize refused: nothing was published. See CI for the tagged commit. A flake: rerun CI's failed jobs, then gh workflow run release-finalize.yml -R $repo -f tag=$tag (or -Resume). A real failure: fix main and release the next version; never move the tag." }
          'Check every expected file' { Stop-At 'finalize: missing or mismatched files' "Report the log (gh run view $($run.databaseId) -R $repo --log-failed). The human decides which build to upload." }
          'site|webapp' { Stop-At 'deploy site/webapp check failed' "Jobs: $jobs. Rerun that deploy once (playbook D/E); still failing: report." }
          'server' { Stop-At 'deploy server failed' "Report the log (gh run view $($run.databaseId) -R $repo --log-failed). The server rolled back by itself; don't retry without the human." }
          default { Stop-At 'finalize failed' "Jobs: $jobs, step: $step. Report: gh run view $($run.databaseId) -R $repo --log-failed" }
        }
      }
      Ok 'finalize succeeded (published, deployed)'
    }
  }

  # ── 9. Final checks ──
  Step 'Final checks'
  $site = Get-Text 'https://iskra.foo/'
  $siteVersion = if ($site) { ([regex]::Matches($site, 'releases/download/v([0-9A-Za-z.\-]+)/') | ForEach-Object { $_.Groups[1].Value } | Select-Object -First 1) } else { $null }
  $app = Get-Text 'https://app.iskra.foo/'
  $asset = if ($app) { ([regex]::Match($app, '/assets/index-[A-Za-z0-9_-]+\.js')).Value } else { $null }
  $appJs = if ($asset) { Get-Text "https://app.iskra.foo$asset" } else { $null }
  $appHas = [bool]($appJs -and ($appJs.Contains("'$Version'") -or $appJs.Contains("`"$Version`"")))
  $health = Get-Text 'https://chat.iskra.foo/health'
  $chatVersion = if ($health) { try { ($health | ConvertFrom-Json).version } catch { $null } } else { $null }
  if ($DryRun) {
    Info "now: iskra.foo links to $siteVersion; app.iskra.foo bundle $(if ($appHas) { 'already has' } else { "doesn't have" }) $Version; chat.iskra.foo runs $chatVersion"
    Would "check: $tag is Latest (not draft, not prerelease), every file + SHA256SUMS.txt is there, iskra.foo links to $Version, app.iskra.foo serves it, chat.iskra.foo/health says $Version"
    Write-Host ''
    if ($script:dryProblems) { Write-Host "Dry run done: $($script:dryProblems) problem(s) above would stop a real run. Nothing was changed." -ForegroundColor Yellow }
    else { Write-Host 'Dry run done: a real run would go ahead. Nothing was changed.' -ForegroundColor Green }
    exit 0
  }
  $fails = @()
  $rel = Gh-Json @('release', 'view', $tag, '-R', $repo, '--json', 'isDraft,isPrerelease,assets')
  $latest = gh release view -R $repo --json tagName --jq .tagName 2>$null
  if (-not $rel -or $rel.isDraft -or $rel.isPrerelease -or $latest -ne $tag) { $fails += "release: Latest is $latest, draft $($rel.isDraft), prerelease $($rel.isPrerelease)" } else { Ok "$tag is Latest" }
  $names = @($rel.assets | ForEach-Object name)
  $missing = Missing-Assets $names @()
  if ($missing.Count -or $names -notcontains 'SHA256SUMS.txt') { $fails += "files missing: $(@($missing) + @($(if ($names -notcontains 'SHA256SUMS.txt') { 'SHA256SUMS.txt' })) -join ', ')" } else { Ok "all $($names.Count) files on the release, with SHA256SUMS.txt" }
  if ($siteVersion -ne $Version) { $fails += "iskra.foo links to $siteVersion" } else { Ok "iskra.foo links to $Version" }
  if (-not $appHas) { $fails += "app.iskra.foo's bundle ($asset) doesn't have $Version" } else { Ok "app.iskra.foo serves $Version" }
  if ($chatVersion -ne $Version) { $fails += "chat.iskra.foo runs $chatVersion" } else { Ok "chat.iskra.foo runs $Version" }
  if ($fails.Count) { Stop-At 'final checks failed' "$($fails -join '; '). A site/web app check: rerun that deploy once (playbook D/E). Otherwise report." }

  Write-Host ''
  Write-Host "Task: release $Version" -ForegroundColor Green
  Write-Host 'Result: done'
  Write-Host "Release: https://github.com/$repo/releases/tag/$tag"
  if ($runs.Count) { Write-Host "Runs: $(($runs.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', ')" }
  Write-Host "Checks: iskra.foo ok, app.iskra.foo ok, chat.iskra.foo ok, Latest = $tag yes"
  Write-Host "Took $([int]((Get-Date) - $started).TotalMinutes) min. Next: git checkout main if you're on the tag."
} finally { Pop-Location }
