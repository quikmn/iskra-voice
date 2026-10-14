# Step of scripts/release.ps1 (the one release command); not run by hand. Local checks shared by release.ps1 and
# release-windows.ps1: the code-signing test signature (SimplySign) and the Android build prerequisites.
# Tested by scripts/release-checks.test.mjs (fake certificates, a fake signer, a fake tools folder).

$script:Subject = 'Open Source Developer Viktor Lundgren'
$script:CodeSigning = '1.3.6.1.5.5.7.3.3'
$script:LoginLine = 'Log in to SimplySign Desktop (6-digit code from the app), then run scripts/release.ps1 again.'

function Get-SigningSubject { $script:Subject }
function Get-SimplySignLoginLine { $script:LoginLine }

# The newest code-signing certificate with a private key and the Iskra subject. SimplySign Desktop puts it in
# CurrentUser\My while it's logged in.
function Find-SigningCertificate {
  param([object[]]$Certificates)
  if ($null -eq $Certificates) { $Certificates = @(Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue) }
  $Certificates |
    Where-Object { $_.HasPrivateKey -and $_.Subject -like "*$script:Subject*" -and (@($_.EnhancedKeyUsageList.ObjectId) -contains $script:CodeSigning) } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
}

# Signs a scratch file the way the build does (SHA256, Certum's timestamp server), so a logged-out SimplySign fails
# here in seconds instead of in the middle of a build. Returns @{ Ok; Reason (no-cert, expired, sign-failed); Message;
# Certificate; ExpiresSoon }. -Signer replaces Set-AuthenticodeSignature (tests): param($file, $cert) → @{ Status; StatusMessage }.
function Test-Signing {
  param([object[]]$Certificates, [scriptblock]$Signer, [datetime]$Now = (Get-Date), [string]$TimestampServer = 'http://time.certum.pl')
  $cert = Find-SigningCertificate -Certificates $Certificates
  if (-not $cert) {
    return @{ Ok = $false; Reason = 'no-cert'; Message = "SimplySign isn't logged in (no '$script:Subject' code-signing certificate in the store). $script:LoginLine" }
  }
  if ($cert.NotAfter -lt $Now) {
    return @{ Ok = $false; Reason = 'expired'; Certificate = $cert; Message = "The code-signing certificate expired on $($cert.NotAfter.ToString('yyyy-MM-dd')). Renew it with Certum (docs/ci-cd.md, Windows code signing)." }
  }
  if (-not $Signer) {
    $Signer = {
      param($file, $c)
      Set-AuthenticodeSignature -FilePath $file -Certificate $c -HashAlgorithm SHA256 -TimestampServer $TimestampServer -ErrorAction Stop
    }
  }
  $probe = Join-Path ([IO.Path]::GetTempPath()) "iskra-sign-probe-$PID-$([guid]::NewGuid().ToString('N').Substring(0, 8)).ps1"
  Set-Content -Path $probe -Value '# signing probe' -Encoding utf8
  try {
    $result = & $Signer $probe $cert
    if ("$($result.Status)" -ne 'Valid') {
      return @{ Ok = $false; Reason = 'sign-failed'; Certificate = $cert; Message = "SimplySign can't sign (test signature: $($result.StatusMessage)). $script:LoginLine" }
    }
  } catch {
    return @{ Ok = $false; Reason = 'sign-failed'; Certificate = $cert; Message = "SimplySign can't sign (test signature failed: $($_.Exception.Message)). $script:LoginLine" }
  } finally { Remove-Item $probe -ErrorAction SilentlyContinue }
  @{ Ok = $true; Certificate = $cert; ExpiresSoon = ($cert.NotAfter -lt $Now.AddDays(30)); Message = "signing works ($script:Subject, valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))" }
}

# The folder above the repo that holds devtools\ and devkeys\ (D:\Development_Projects here).
function Get-DevRoot {
  param([Parameter(Mandatory)][string]$Repo)
  $d = $Repo
  while ($d -and -not (Test-Path (Join-Path $d 'devtools'))) { $d = Split-Path $d -Parent }
  if ($d) { $d } else { 'D:\Development_Projects' }
}

function Get-JdkMajor([string]$path) {
  $release = Join-Path $path 'release'
  if (-not $path -or -not (Test-Path $release)) { return 0 }
  $line = Get-Content $release | Where-Object { $_ -match '^JAVA_VERSION="(\d+)' } | Select-Object -First 1
  if ($line -match '^JAVA_VERSION="(\d+)') { [int]$Matches[1] } else { 0 }
}

# What mobile/scripts/build-android.ps1 needs, found the same way it finds them (presence only: never reads the
# keystore or its password file). Returns a list of problems; empty when the build can start.
function Get-AndroidProblems {
  param([Parameter(Mandatory)][string]$DevRoot, [hashtable]$Environment, [string[]]$JdkInstalls = @('C:\Program Files\Java\jdk-21'))
  if ($null -eq $Environment) { $Environment = @{} ; foreach ($k in 'ISKRA_ANDROID_JDK', 'ISKRA_ANDROID_SDK', 'ISKRA_ANDROID_KEYSTORE', 'ISKRA_ANDROID_KEYSTORE_INFO', 'ISKRA_ANDROID_KEYSTORE_PASSWORD', 'JAVA_HOME') { $Environment[$k] = [Environment]::GetEnvironmentVariable($k) } }
  $setting = { param($name, $default) if ($Environment[$name]) { $Environment[$name] } else { $default } }
  $problems = @()
  $jdk = @($Environment['ISKRA_ANDROID_JDK'], (Join-Path $DevRoot 'devtools' 'jdk-21'), $Environment['JAVA_HOME']) + $JdkInstalls |
    Where-Object { $_ -and (Get-JdkMajor $_) -ge 21 } | Select-Object -First 1
  if (-not $jdk) { $problems += 'No JDK 21 for the Android build: install Temurin 21 into devtools\jdk-21 or set ISKRA_ANDROID_JDK (mobile/README.md)' }
  $sdk = & $setting 'ISKRA_ANDROID_SDK' (Join-Path $DevRoot 'devtools' 'android-sdk')
  if (-not (Test-Path $sdk)) { $problems += "Missing the Android SDK at $sdk (mobile/README.md)" }
  elseif (-not (Test-Path (Join-Path $sdk 'build-tools' '36.1.0'))) { $problems += "Missing Android build-tools 36.1.0 in $sdk (mobile/README.md)" }
  $keystore = & $setting 'ISKRA_ANDROID_KEYSTORE' (Join-Path $DevRoot 'devkeys' 'iskra-android.keystore')
  if (-not (Test-Path $keystore)) { $problems += "Missing the Android release keystore at $keystore (docs/ci-cd.md, Android; never make a new one)" }
  if (-not $Environment['ISKRA_ANDROID_KEYSTORE_PASSWORD']) {
    $info = & $setting 'ISKRA_ANDROID_KEYSTORE_INFO' (Join-Path $DevRoot 'devkeys' 'iskra-android-keystore.txt')
    if (-not (Test-Path $info)) { $problems += "Missing the keystore password file at $info (docs/ci-cd.md, Android)" }
  }
  $problems
}

Export-ModuleMember -Function Get-SigningSubject, Get-SimplySignLoginLine, Find-SigningCertificate, Test-Signing, Get-DevRoot, Get-AndroidProblems
