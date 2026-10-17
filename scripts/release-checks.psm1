# Step of scripts/release.ps1 (the one release command) and of the Release workflow's jobs on the home PC
# (release-all.yml); not run by hand. Local checks shared by release.ps1, release-windows.ps1 and release-pc-checks.ps1:
# the code-signing test signature (SimplySign, with the automatic login) and the Android build prerequisites.
# Tested by scripts/release-checks.test.mjs (fake certificates, a fake signer, a fake login, a fake tools folder).

# Find-LoginForm and Close-LoginForm for the test signature's login dialog watch.
Import-Module (Join-Path $PSScriptRoot 'simplysign.psm1')

$script:Subject = 'Open Source Developer Viktor Lundgren'
$script:CodeSigning = '1.3.6.1.5.5.7.3.3'
$script:LoginLine = 'Log in to SimplySign Desktop (6-digit code from the app), then run scripts/release.ps1 again.'
# The same on GitHub (the Release workflow's jobs on the home PC).
$script:LoginLineGitHub = 'Log in to SimplySign Desktop on the home PC (6-digit code from the app), then re-run the failed jobs of this Release run.'

function Get-SigningSubject { $script:Subject }
function Get-SimplySignLoginLine { if ($env:GITHUB_ACTIONS -eq 'true') { $script:LoginLineGitHub } else { $script:LoginLine } }

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
    return @{ Ok = $false; Reason = 'no-cert'; Message = "SimplySign isn't logged in (no '$script:Subject' code-signing certificate in the store). $(Get-SimplySignLoginLine)" }
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
      return @{ Ok = $false; Reason = 'sign-failed'; Certificate = $cert; Message = "SimplySign can't sign (test signature: $($result.StatusMessage)). $(Get-SimplySignLoginLine)" }
    }
  } catch {
    return @{ Ok = $false; Reason = 'sign-failed'; Certificate = $cert; Message = "SimplySign can't sign (test signature failed: $($_.Exception.Message)). $(Get-SimplySignLoginLine)" }
  } finally { Remove-Item $probe -ErrorAction SilentlyContinue }
  @{ Ok = $true; Certificate = $cert; ExpiresSoon = ($cert.NotAfter -lt $Now.AddDays(30)); Message = "signing works ($script:Subject, valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))" }
}

# Runs a login script (simplysign-login.ps1 with these arguments) in its own pwsh: @{ Code; Line }.
function Invoke-LoginScript {
  param([string[]]$Arguments = @())
  $script = Join-Path $PSScriptRoot 'simplysign-login.ps1'
  $out = & pwsh -NoProfile -NonInteractive -File $script @Arguments 2>&1 | ForEach-Object { "$_" }
  @{ Code = $LASTEXITCODE; Line = (($out | Where-Object { $_ -like 'SimplySign login:*' } | Select-Object -Last 1) -replace '^SimplySign login:\s*', '') }
}

# Test-Signing in a child process with a time limit. A signature through SimplySign doesn't fail when SimplySign's
# session has ended (a login lasts 2 hours) while its certificate is still in the store: SimplySign shows its login
# dialog and the signature waits for someone to log in. So while the signature runs, this looks for that dialog about
# once a second; when it shows, -Fill fills it once with the stored seed (simplysign-login.ps1 -NoCheck, within the
# attempt ledger) and the signature gets -LoginSeconds more to finish. When it can't be filled, the child is stopped
# and the dialog closed (Reason 'login-dialog'). No result within -TimeoutSeconds and no dialog: the child is stopped
# (Reason 'sign-timeout'). -NoLogin: only the time limit (simplysign-login.ps1's own checks).
# -Test runs in the child with this module loaded (default Test-Signing); -FindDialog, -Fill and -CloseDialog replace
# Find-LoginForm, simplysign-login.ps1 -NoCheck and Close-LoginForm (tests). Result: Test-Signing's (Certificate
# deserialized), with AutoLogin = $true when the filled dialog made it work.
function Invoke-SigningProbe {
  param(
    [scriptblock]$Test = { Test-Signing },
    [scriptblock]$FindDialog = { Find-LoginForm },
    [scriptblock]$Fill = { Invoke-LoginScript -Arguments '-NoCheck' },
    [scriptblock]$CloseDialog = { $f = Find-LoginForm; if ($f) { Close-LoginForm -Form $f } },
    [switch]$NoLogin,
    [int]$TimeoutSeconds = 60, [int]$LoginSeconds = 120, [double]$PollSeconds = 1
  )
  $out = Join-Path ([IO.Path]::GetTempPath()) "iskra-sign-probe-$PID-$([guid]::NewGuid().ToString('N').Substring(0, 8)).xml"
  $module = (Join-Path $PSScriptRoot 'release-checks.psm1').Replace("'", "''")
  $child = @"
`$ErrorActionPreference = 'Stop'
Import-Module '$module' -Force
try { `$r = & { $Test } } catch { `$r = @{ Ok = `$false; Reason = 'sign-failed'; Message = "SimplySign can't sign (test signature failed: `$(`$_.Exception.Message)). `$(Get-SimplySignLoginLine)" } }
Export-Clixml -LiteralPath '$($out.Replace("'", "''"))' -InputObject `$r -Depth 2
"@
  $start = @{
    FilePath = (Get-Process -Id $PID).Path
    ArgumentList = @('-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child)))
    PassThru = $true
  }
  if ($IsWindows) { $start.WindowStyle = 'Hidden' }
  $p = Start-Process @start
  $stop = { try { $p.Kill($true) } catch { $null = $_ }; $null = $p.WaitForExit(10000) }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $login = $null
  try {
    while (-not $p.WaitForExit([int]($PollSeconds * 1000))) {
      if ((Get-Date) -ge $deadline) {
        & $stop
        if ($login) { return @{ Ok = $false; Reason = 'sign-timeout'; Message = "SimplySign asked to log in and the automatic login went in ($($login.Line)), but the test signature still didn't finish within $LoginSeconds s. $(Get-SimplySignLoginLine)" } }
        return @{ Ok = $false; Reason = 'sign-timeout'; Message = "SimplySign's test signature didn't finish within $TimeoutSeconds s and SimplySign showed no login dialog (restart SimplySign Desktop). $(Get-SimplySignLoginLine)" }
      }
      if ($NoLogin -or $login -or -not (& $FindDialog)) { continue }
      # SimplySign's session ended and it asks to log in: the stored seed goes in now.
      $login = & $Fill
      if ($login.Code -ne 0) {
        & $stop
        & $CloseDialog
        $why = if ($login.Code -eq 2) { 'no seed is stored' } else { "the automatic login didn't help ($($login.Line))" }
        return @{ Ok = $false; Reason = 'login-dialog'; Message = "SimplySign's session ended (it asked to log in) and $why. $(Get-SimplySignLoginLine)" }
      }
      $deadline = (Get-Date).AddSeconds($LoginSeconds)
    }
    if (-not (Test-Path -LiteralPath $out)) {
      return @{ Ok = $false; Reason = 'sign-failed'; Message = "SimplySign's test signature stopped without a result (exit code $($p.ExitCode)). $(Get-SimplySignLoginLine)" }
    }
    $r = Import-Clixml -LiteralPath $out
    if ($login) {
      if ($r.Ok) { $r.AutoLogin = $true; $r.Message = "$($r.Message); SimplySign logged itself in" }
      else { $r.Message = "SimplySign logged in, but the test signature still fails: $($r.Message)" }
    }
    $r
  } finally {
    if (-not $p.HasExited) { & $stop }
    Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue
  }
}

# While a build signs (scripts/release-windows.ps1): a hidden pwsh running simplysign-login.ps1 -Watch, which fills
# SimplySign's login dialog with the stored seed whenever it shows (or closes it when it can't), and ends with this
# process. Stop-LoginWatcher stops it and prints what it did. Only one at a time, and never while Confirm-Signing runs
# (both would fill the same dialog).
function Start-LoginWatcher {
  $log = Join-Path ([IO.Path]::GetTempPath()) "iskra-simplysign-watch-$PID-$([guid]::NewGuid().ToString('N').Substring(0, 8)).log"
  $start = @{
    FilePath = (Get-Process -Id $PID).Path
    ArgumentList = @('-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'simplysign-login.ps1'), '-Watch', '-ParentPid', "$PID")
    RedirectStandardOutput = $log
    PassThru = $true
  }
  if ($IsWindows) { $start.WindowStyle = 'Hidden' }
  [pscustomobject]@{ Process = (Start-Process @start); Log = $log }
}

function Stop-LoginWatcher {
  param([Parameter(Mandatory)]$Watcher)
  try { if (-not $Watcher.Process.HasExited) { $Watcher.Process.Kill($true) } } catch { $null = $_ }
  $null = $Watcher.Process.WaitForExit(10000)
  if (Test-Path -LiteralPath $Watcher.Log) {
    Get-Content -LiteralPath $Watcher.Log | Where-Object { $_ -like 'SimplySign login:*' } | ForEach-Object { Write-Host $_ }
    Remove-Item -LiteralPath $Watcher.Log -ErrorAction SilentlyContinue
  }
}

# The test signature (Invoke-SigningProbe: time limit, and the dialog SimplySign opens when its session ended filled
# with the stored seed), and when it fails because SimplySign isn't logged in at all, scripts/simplysign-login.ps1 once
# (it logs in with the seed stored by simplysign-setup.ps1; within the attempt ledger), then the test signature again.
# Without a stored seed nothing changes: the result says to log in by hand. -Test and -Login replace the real test
# signature and login (tests): -Login returns @{ Code (0 ok, 2 no seed, 3 not allowed now, 1 failed); Line }.
# The result gets AutoLogin = $true when a login made it work.
function Confirm-Signing {
  param([scriptblock]$Test, [scriptblock]$Login)
  if (-not $Test) { $Test = { Invoke-SigningProbe } }
  if (-not $Login) { $Login = { Invoke-LoginScript } }
  $s = & $Test
  # Expired: renew, not log in. The probe already handled a login dialog, or timed out with none: no second login.
  if ($s.Ok -or $s.Reason -in 'expired', 'login-dialog', 'sign-timeout') { return $s }
  $r = & $Login
  if ($r.Code -eq 2) { return $s }
  if ($r.Code -ne 0) {
    $s.Message = "SimplySign isn't logged in and the automatic login didn't help ($($r.Line)). $(Get-SimplySignLoginLine)"
    return $s
  }
  $again = & $Test
  if ($again.Ok) { $again.AutoLogin = $true; $again.Message = "$($again.Message); SimplySign logged itself in" }
  else { $again.Message = "SimplySign logged in, but the test signature still fails: $($again.Message)" }
  $again
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

# Whether the jobs of a workflow run that a caller waits for have all completed: for each name, at least one job is
# named exactly that or "<name> / ..." (a called workflow's jobs, which only appear once it starts) and every such job
# has status completed. release.ps1 waits for finalize's publish, deploy and TestFlight upload jobs this way, not for
# the TestFlight groups job (Apple's processing, up to an hour). $Jobs: gh run view --json jobs (name, status).
function Test-JobsDone {
  param([AllowEmptyCollection()][AllowNull()][object[]]$Jobs, [Parameter(Mandatory)][string[]]$Names)
  foreach ($n in $Names) {
    $matched = @($Jobs | Where-Object { $_ -and ($_.name -eq $n -or "$($_.name)".StartsWith("$n / ")) })
    if (-not $matched.Count) { return $false }
    if (@($matched | Where-Object { $_.status -ne 'completed' }).Count) { return $false }
  }
  return $true
}

# Whether a folder needs `npm ci` before building: no node_modules, or package-lock.json changed since the last install
# (npm writes node_modules/.package-lock.json on every install). A merge that updates the lockfile otherwise leaves the
# old packages in place, and the release builds against them (alpha.29 stopped this way after a dependency update).
function Test-NodeModulesStale {
  param([Parameter(Mandatory)][string]$Folder)
  $lock = Join-Path $Folder 'package-lock.json'
  $installed = Join-Path $Folder 'node_modules/.package-lock.json'
  if (-not (Test-Path $installed)) { return $true }
  if (-not (Test-Path $lock)) { return $false }
  return (Get-Item $lock).LastWriteTimeUtc -gt (Get-Item $installed).LastWriteTimeUtc
}

Export-ModuleMember -Function Get-SigningSubject, Get-SimplySignLoginLine, Find-SigningCertificate, Test-Signing, Invoke-LoginScript, Invoke-SigningProbe, Start-LoginWatcher, Stop-LoginWatcher, Confirm-Signing, Get-DevRoot, Get-AndroidProblems, Test-JobsDone, Test-NodeModulesStale
