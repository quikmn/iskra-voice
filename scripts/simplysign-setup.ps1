#Requires -Version 7
# Stores the SimplySign TOTP seed on this PC, once, so releases can log SimplySign Desktop in by themselves
# (scripts/simplysign-login.ps1; docs/ci-cd.md, "SimplySign auto-login"). The owner runs it in their own window.
#
#   simplysign-setup.ps1                      # asks for the e-mail and the otpauth:// link or Base32 seed (hidden)
#   simplysign-setup.ps1 -Method switches     # log in through SimplySign's own /otpauth + /autologin switches
#   simplysign-setup.ps1 -Remove              # deletes the stored seed
#
# The seed is stored with DPAPI for this Windows account only (%LOCALAPPDATA%\Iskra\simplysign.dat). It is never
# printed, logged or sent anywhere, and it never goes to GitHub. Keep scanning the same QR code into the SimplySign
# phone app too: the phone stays a way to log in by hand.
param(
  [switch]$Remove,
  [ValidateSet('dialog', 'switches')][string]$Method = 'dialog',
  [string]$Email = ''
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'simplysign.psm1') -Force
$path = Get-SimplySignSeedPath

if ($Remove) {
  if (Remove-SimplySignSeed) { Write-Host "Removed the stored SimplySign seed ($path)." } else { Write-Host "No SimplySign seed is stored ($path)." }
  exit 0
}
if (-not $IsWindows) { Write-Host 'This only works on the Windows PC that signs releases.'; exit 1 }

if (Test-Path -LiteralPath $path) { Write-Host "A seed is stored already; this replaces it." }
if (-not $Email) { $Email = (Read-Host 'SimplySign account e-mail').Trim() }
$secure = Read-Host -AsSecureString 'Paste the otpauth:// link or the Base32 seed (hidden)'
$text = [Net.NetworkCredential]::new('', $secure).Password
try {
  $seed = ConvertFrom-SeedInput $text
} catch {
  Write-Host "Not stored: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally { $text = $null }
if ($Method -eq 'switches' -and -not $seed.Raw) { Write-Host 'Not stored: the switches method needs the whole otpauth:// link, not only the seed.' -ForegroundColor Red; exit 1 }

# A code to compare with the phone app (it changes every $($seed.Period) s); the seed itself is never shown.
$code = Get-Totp -Secret $seed.Secret -Algorithm $seed.Algorithm -Digits $seed.Digits -Period $seed.Period
Write-Host ''
Write-Host "The code right now is $code ($(Get-TotpSecondsLeft -Period $seed.Period) s left). The SimplySign phone app should show the same."
$answer = Read-Host 'Same code? (y/n)'
if ($answer -notmatch '^(y|yes|j|ja)$') { Write-Host 'Not stored. Check you copied the whole link or seed, and try again.' -ForegroundColor Yellow; exit 1 }

Save-SimplySignSeed -Seed $seed -Email $Email -Method $Method
Write-Host "Stored for this Windows account only ($path, DPAPI). Method: $Method." -ForegroundColor Green
Write-Host 'Releases now log SimplySign Desktop in by themselves when a test signature fails.'
