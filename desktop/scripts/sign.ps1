# Build step (npm run dist, build-sidecar.mjs), called by scripts/release.ps1's Windows step; not run by hand.
# Signs files with the Iskra code-signing certificate (Certum, "Open Source Developer Viktor Lundgren"),
# timestamped so signatures stay valid after the certificate expires. Skips quietly if the certificate
# isn't on this machine, so anyone can still build unsigned, except in a release (ISKRA_REQUIRE_SIGNING=1), where
# a missing certificate means SimplySign logged out and the build must stop.
param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Files)
$ErrorActionPreference = 'Stop'
# Filters on the key usage itself: -CodeSigningCert is missing when the module path points at PowerShell 7's modules.
$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.HasPrivateKey -and $_.Subject -like '*Open Source Developer Viktor Lundgren*' -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') } |
  Select-Object -First 1
if (-not $cert) {
  if ($env:ISKRA_REQUIRE_SIGNING -eq '1') { throw 'Signing failed: no code-signing certificate (SimplySign Desktop logged out?)' }
  Write-Host 'No code-signing certificate found: leaving files unsigned.' -ForegroundColor Yellow; exit 0
}
foreach ($file in $Files) {
  $result = Set-AuthenticodeSignature -FilePath $file -Certificate $cert -TimestampServer 'http://time.certum.pl' -HashAlgorithm SHA256
  if ($result.Status -ne 'Valid') { throw "Signing $file failed: $($result.StatusMessage)" }
  Write-Host "Signed $file"
}
