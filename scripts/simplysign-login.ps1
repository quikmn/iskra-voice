#Requires -Version 7
# Step of the release (scripts/release-checks.psm1 Confirm-Signing calls it when the test signature fails); not run by
# hand. Logs SimplySign Desktop in by itself with the TOTP seed stored by scripts/simplysign-setup.ps1, then checks it
# with a test signature on a scratch file. docs/ci-cd.md, "SimplySign auto-login".
#
#   simplysign-login.ps1                     # log in if needed (the stored method)
#   simplysign-login.ps1 -Method switches    # this once: SimplySign's own /otpauth + /autologin switches
#
# At most ONE login attempt per release run (GitHub run and attempt, or scripts/release.ps1's run), and none for 30
# minutes after a failed one, so the Certum account can't get locked. Never prints the seed or a code.
# Exit 0: signing works (it already did, or after the login). 2: no seed stored (log in by hand, as before).
# 3: no attempt allowed now (one was made this run, or the pause after a failure). 1: the login didn't work.
# The last line says why.
param(
  [ValidateSet('', 'dialog', 'switches')][string]$Method = '',
  [int]$TimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'simplysign.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'release-checks.psm1') -Force

function Done([int]$exitCode, [string]$line) { Write-Host "SimplySign login: $line"; exit $exitCode }

$before = Test-Signing
if ($before.Ok) { Done 0 'already logged in; signing works' }
if ($before.Reason -eq 'expired') { Done 1 $before.Message }

try { $seed = Read-SimplySignSeed } catch { Done 1 $_.Exception.Message }
if (-not $seed) { Done 2 'no seed stored (scripts/simplysign-setup.ps1); log in by hand' }
if (-not $Method) { $Method = $seed.Method }
if ($Method -eq 'switches' -and -not $seed.Uri) { Done 1 "the switches method needs the otpauth:// link, but only a bare seed is stored: store the link with scripts/simplysign-setup.ps1, or use the dialog method" }

$allowed = Test-LoginAllowed
if (-not $allowed.Ok) { Done 3 "$($allowed.Reason). Log in to SimplySign Desktop by hand." }

# Counted from here on: nothing below runs twice in one release run.
Write-LoginAttempt -Result started
$sent = $false
try {
  if ($Method -eq 'switches') {
    $exe = Get-SimplySignExe
    if (-not (Test-Path -LiteralPath $exe)) { throw "SimplySign Desktop isn't installed ($exe)." }
    if (-not (Get-Process SimplySignDesktop -ErrorAction SilentlyContinue)) { Start-Process -FilePath $exe | Out-Null; Start-Sleep -Seconds 5 }
    # A second instance hands its switches to the running one over a named pipe and closes. The link is on that
    # short-lived process's command line, visible only to this account and administrators.
    Start-Process -FilePath $exe -ArgumentList '/otpauth', "`"$($seed.Uri)`"" -Wait | Out-Null
    Start-Sleep -Seconds 2
    $sent = $true
    Start-Process -FilePath $exe -ArgumentList '/autologin' -Wait | Out-Null
  } else {
    $form = Open-LoginForm
    # A code with at least 8 seconds left, so it doesn't change on the way.
    $code = {
      $left = Get-TotpSecondsLeft -Period $seed.Period
      if ($left -lt 8) { Start-Sleep -Seconds ($left + 1) }
      Get-Totp -Secret $seed.Secret -Algorithm $seed.Algorithm -Digits $seed.Digits -Period $seed.Period
    }
    $sent = $true
    Submit-LoginForm -Form $form -Email $seed.Email -Code $code
  }
} catch {
  Write-LoginAttempt -Result $(if ($sent) { 'failed' } else { 'not-sent' })
  Done 1 "couldn't log in ($Method): $($_.Exception.Message)"
}

# The certificate shows up in CurrentUser\My once SimplySign is connected; then a real test signature.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (-not (Find-SigningCertificate) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
$after = Test-Signing
if ($after.Ok) {
  Write-LoginAttempt -Result ok
  Done 0 "logged in ($Method); $($after.Message)"
}
Write-LoginAttempt -Result failed
Done 1 "the login ($Method) didn't work within $TimeoutSeconds s: $($after.Message -replace ' Log in to SimplySign.*$', '')"
