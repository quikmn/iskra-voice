#Requires -Version 7
# Makes the home PC the GitHub Actions runner for the Release workflow's Windows jobs (release-all.yml: the home PC
# checks, the signed Windows build, Play uploads with the PC's key). The owner runs it once, in their own (not
# elevated) PowerShell window, logged in to gh as the repo owner. docs/ci-cd.md, "The home PC runner".
#
#   runner-setup.ps1            # download, check, register, start at logon
#   runner-setup.ps1 -Remove    # stop, unregister on GitHub, delete the runner folder and the logon task
#
# What it sets up:
# - The official runner (github.com/actions/runner), the version below, checked against its SHA-256 before it's unpacked.
# - Registered for quikmn/iskra-voice with only the label iskra-windows-signing (no "self-hosted"/"Windows" labels, so
#   no other job can ask for it by accident), using a one-hour registration token from `gh api`.
# - A job guard (scripts/runner-job-guard.ps1, copied into the runner folder) that refuses every job that isn't the
#   Release workflow's own, started by the owner on main.
# - A logon task (Task Scheduler, "Iskra release runner") that starts the runner hidden when the owner logs in, as the
#   owner: it needs the owner's DPAPI key (the SimplySign seed), the CurrentUser certificate store and SimplySign
#   Desktop in the owner's desktop session, which a Windows service couldn't reach.
# The runner only makes outbound HTTPS connections to GitHub and listens on no port, so Windows Firewall has nothing to
# ask (it prompts only for programs that accept incoming connections) and no rule is needed.
param(
  [switch]$Remove,
  # The runner's folder (its work folder _work goes inside). Default: next to the repo, in the folder that holds devtools.
  [string]$Root = '',
  [string]$Name = "iskra-home-$($env:COMPUTERNAME.ToLowerInvariant())"
)
$ErrorActionPreference = 'Stop'
$repo = 'quikmn/iskra-voice'
$label = 'iskra-windows-signing'
$taskName = 'Iskra release runner'
# actions/runner v2.338.0 (2026-10-06), win-x64; SHA-256 from the release notes and GitHub's asset digest.
$runnerVersion = '2.338.0'
$runnerSha256 = 'f48e0750a21812bca5f82de5f7f5aeae71abee647fab5a582f1742d07eba455f'
$runnerUrl = "https://github.com/actions/runner/releases/download/v$runnerVersion/actions-runner-win-x64-$runnerVersion.zip"

Import-Module (Join-Path $PSScriptRoot 'release-checks.psm1') -Force
if (-not $Root) { $Root = Join-Path (Get-DevRoot -Repo (Split-Path $PSScriptRoot -Parent)) 'iskra-runner' }
function Say([string]$t) { Write-Host $t }
function Fail([string]$t) { Write-Host "Stopped: $t" -ForegroundColor Red; exit 1 }

if (-not $IsWindows) { Fail 'the release runner is the Windows PC that signs releases.' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) { Fail 'run this in a normal PowerShell window, not as administrator: the runner must run as you, without admin rights.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'the GitHub CLI (gh) is not installed.' }
$env:GH_PROMPT_DISABLED = '1'
$isAdmin = gh api "repos/$repo" --jq .permissions.admin 2>$null
if ($isAdmin -ne 'true') { Fail "gh isn't logged in as an admin of $repo (gh auth login, as the owner)." }

function Find-Runner {
  $list = gh api "repos/$repo/actions/runners" --jq ".runners[] | select(.name == `"$Name`") | {id, status}" 2>$null
  if ($list) { $list | ConvertFrom-Json } else { $null }
}
function Stop-RunnerProcesses {
  Get-Process Runner.Listener, Runner.Worker -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) } |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Say "Removed the logon task '$taskName'."
  }
  Stop-RunnerProcesses
  if (Test-Path (Join-Path $Root 'config.cmd')) {
    $token = gh api -X POST "repos/$repo/actions/runners/remove-token" --jq .token
    & (Join-Path $Root 'config.cmd') remove --token $token
    $token = $null
  }
  $left = Find-Runner
  if ($left) { gh api -X DELETE "repos/$repo/actions/runners/$($left.id)" | Out-Null; Say "Unregistered '$Name' on GitHub." }
  if (Test-Path $Root) { Remove-Item -Recurse -Force $Root; Say "Deleted $Root." }
  Say 'The home PC is no longer a release runner. Releases need scripts/release.ps1 on this PC again.'
  exit 0
}

if (Test-Path (Join-Path $Root '.runner')) { Fail "a runner is already set up in $Root. To set it up again: runner-setup.ps1 -Remove, then this." }
if ((Test-Path $Root) -and @(Get-ChildItem -Force $Root).Count) { Fail "$Root isn't empty; pick another -Root or empty it." }

# Download into a new empty folder, check, unpack.
$download = Join-Path ([IO.Path]::GetTempPath()) "iskra-runner-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $download | Out-Null
try {
  $zip = Join-Path $download "actions-runner-win-x64-$runnerVersion.zip"
  Say "Downloading the GitHub Actions runner $runnerVersion ..."
  Invoke-WebRequest -Uri $runnerUrl -OutFile $zip
  $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $runnerSha256) { Fail "the download's SHA-256 is $hash, expected $runnerSha256. Nothing was installed." }
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  Expand-Archive -Path $zip -DestinationPath $Root
} finally { Remove-Item -Recurse -Force $download -ErrorAction SilentlyContinue }
Say "Checked and unpacked into $Root."

# Register: only our label, our work folder.
$token = gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token
if (-not $token) { Fail "couldn't get a registration token (gh api repos/$repo/actions/runners/registration-token)." }
& (Join-Path $Root 'config.cmd') --unattended --url "https://github.com/$repo" --token $token --name $Name --labels $label --no-default-labels --work _work --replace
$code = $LASTEXITCODE
$token = $null
if ($code -ne 0) { Fail "the runner's config.cmd failed (exit code $code)." }

# The job guard, run before every job.
$hooks = Join-Path $Root 'hooks'
New-Item -ItemType Directory -Force -Path $hooks | Out-Null
$guard = Join-Path $hooks 'job-started.ps1'
Copy-Item (Join-Path $PSScriptRoot 'runner-job-guard.ps1') $guard -Force
Set-Content -Path (Join-Path $Root '.env') -Value "ACTIONS_RUNNER_HOOK_JOB_STARTED=$guard" -Encoding ascii
Say 'Job guard installed (only the Release workflow, by the owner, on main).'

# Start at logon, hidden, as this user (not elevated); restart it if it stops.
$pwsh = (Get-Command pwsh).Source
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"& '$(Join-Path $Root 'run.cmd')'`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'GitHub Actions runner for Iskra releases (scripts/runner-setup.ps1). Only the Release workflow uses it.' | Out-Null
Start-ScheduledTask -TaskName $taskName
Say "Logon task '$taskName' registered and started."

$online = $false
for ($i = 0; $i -lt 20 -and -not $online; $i++) {
  Start-Sleep -Seconds 3
  $online = (Find-Runner).status -eq 'online'
}
if ($online) { Write-Host "Runner '$Name' is online on GitHub with the label $label." -ForegroundColor Green }
else { Say "Runner '$Name' is registered but not online yet; check Settings → Actions → Runners in a minute." }
Say ''
Say 'Keep this PC switched on and logged in for releases (screen lock is fine; sleep is not: Settings → System → Power → never sleep while plugged in).'
