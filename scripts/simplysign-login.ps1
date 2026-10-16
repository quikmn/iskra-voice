#Requires -Version 7
# Step of the release (scripts/release-checks.psm1 Confirm-Signing calls it when the test signature fails); not run by
# hand. Logs SimplySign Desktop in by itself with the TOTP seed stored by scripts/simplysign-setup.ps1, then checks it
# with a test signature on a scratch file. docs/ci-cd.md, "SimplySign auto-login".
#
#   simplysign-login.ps1                     # log in if needed
#   simplysign-login.ps1 -NoCheck            # fill the login dialog SimplySign has open now (a signature is waiting
#                                            # for it); no test signature, no restart (Confirm-Signing's probe)
#   simplysign-login.ps1 -Watch -ParentPid N # until process N ends: fill that dialog whenever it shows (the build)
#
# At most ONE login attempt per release run (GitHub run and attempt, or scripts/release.ps1's run); a second only when
# the first one worked and its session has since ended (90 minutes or more; a login lasts 2 hours). None for 30 minutes
# after a failed one, so the Certum account can't get locked. Never prints the seed or a code.
# Exit 0: signing works (it already did, or after the login; -NoCheck: the dialog closed after the code went in).
# 2: no seed stored (log in by hand, as before). 3: no attempt allowed now (one was made this run, or the pause after a
# failure). 1: the login didn't work. The last line says why.
param(
  [int]$TimeoutSeconds = 90,
  [switch]$NoCheck,
  [switch]$Watch,
  [int]$ParentPid = 0
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'simplysign.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'release-checks.psm1') -Force

function Done([int]$exitCode, [string]$line) { Write-Host "SimplySign login: $line"; exit $exitCode }

if ($Watch) { Watch-LoginDialog -ParentPid $ParentPid; exit 0 }
if ($NoCheck) {
  $r = Invoke-OpenDialogLogin -TimeoutSeconds $TimeoutSeconds
  Done $r.Code $r.Line
}

# Test signatures with a time limit and without the automatic login (this is it): one through a SimplySign whose
# session ended waits for a login instead of failing.
$before = Invoke-SigningProbe -NoLogin
if ($before.Ok) { Done 0 'already logged in; signing works' }
if ($before.Reason -eq 'expired') { Done 1 $before.Message }

try { $seed = Read-SimplySignSeed } catch { Done 1 $_.Exception.Message }
if (-not $seed) { Done 2 'no seed stored (scripts/simplysign-setup.ps1); log in by hand' }
# The 'switches' method (SimplySign's own /otpauth and /autologin, which put the seed on a command line) is retired:
# a seed stored for it logs in through the dialog like any other.
if ($seed.Method -eq 'switches') { Write-Host "SimplySign login: the stored method 'switches' is retired; using the login dialog (store the seed again with scripts/simplysign-setup.ps1 to drop this note)" }

$allowed = Test-LoginAllowed
if (-not $allowed.Ok) { Done 3 "$($allowed.Reason). Log in to SimplySign Desktop by hand." }

# Counted from here on: nothing below runs twice in one release run.
Write-LoginAttempt -Result started
$sent = $false
try {
  $form = Open-LoginForm
  # A code with at least 8 seconds left, so it doesn't change on the way.
  $code = {
    $left = Get-TotpSecondsLeft -Period $seed.Period
    if ($left -lt 8) { Start-Sleep -Seconds ($left + 1) }
    Get-Totp -Secret $seed.Secret -Algorithm $seed.Algorithm -Digits $seed.Digits -Period $seed.Period
  }
  $sent = $true
  Submit-LoginForm -Form $form -Email $seed.Email -Code $code
} catch {
  Write-LoginAttempt -Result $(if ($sent) { 'failed' } else { 'not-sent' })
  Done 1 "couldn't log in: $($_.Exception.Message)"
}

# The certificate shows up in CurrentUser\My once SimplySign is connected; then a real test signature.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while (-not (Find-SigningCertificate) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
$after = Invoke-SigningProbe -NoLogin
if ($after.Ok) {
  Write-LoginAttempt -Result ok
  Done 0 "logged in; $($after.Message)"
}
Write-LoginAttempt -Result failed
Done 1 "the login didn't work within $TimeoutSeconds s: $($after.Message -replace ' Log in to SimplySign.*$', '')"
