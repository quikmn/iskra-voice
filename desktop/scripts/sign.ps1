# Signs files with the Iskra code-signing certificate (Certum, "Open Source Developer Viktor Lundgren"),
# timestamped so signatures stay valid after the certificate expires. Skips quietly if the certificate
# isn't on this machine, so anyone can still build unsigned.
param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Files)
$ErrorActionPreference = 'Stop'
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object Subject -like '*Open Source Developer Viktor Lundgren*' | Select-Object -First 1
if (-not $cert) { Write-Host 'No code-signing certificate found: leaving files unsigned.' -ForegroundColor Yellow; exit 0 }
foreach ($file in $Files) {
  $result = Set-AuthenticodeSignature -FilePath $file -Certificate $cert -TimestampServer 'http://time.certum.pl' -HashAlgorithm SHA256
  if ($result.Status -ne 'Valid') { throw "Signing $file failed: $($result.StatusMessage)" }
  Write-Host "Signed $file"
}
