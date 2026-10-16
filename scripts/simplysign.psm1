# Step module of scripts/simplysign-setup.ps1 and simplysign-login.ps1 (SimplySign Desktop logging itself in on the
# home PC; docs/ci-cd.md, "SimplySign auto-login"). Not run by hand.
#
# - TOTP codes (RFC 6238 with .NET's HMAC; RFC 4648 Base32), from an otpauth:// URI or a Base32 seed.
# - The seed, stored with DPAPI (CurrentUser) in %LOCALAPPDATA%\Iskra\simplysign.dat: only this Windows account can read
#   it back. It is never printed or logged; nothing here writes it anywhere else.
# - The attempt ledger: at most one login attempt per release run (another only after the last one worked and its
#   session has since ended: 90 minutes or more), and none for 30 minutes after one failed, so the Certum account can't
#   get locked by a loop.
# - The login itself: SimplySign Desktop's login dialog filled with window messages (default), or its /otpauth and
#   /autologin switches. Invoke-OpenDialogLogin fills a dialog SimplySign opened by itself (a signature waiting for a
#   login); Watch-LoginDialog does that for as long as a build runs.
# Tested by scripts/simplysign.test.mjs (RFC 6238 vectors, a DPAPI round trip with a fake seed, the ledger, the dialog
# login and the watcher with fake dialogs).

$script:FileHeader = 'ISKRA-SIMPLYSIGN-1'
# DPAPI's optional entropy: a context string, so this blob can't be confused with any other DPAPI blob of the account.
$script:Entropy = [Text.Encoding]::UTF8.GetBytes('iskra/simplysign-seed/v1')
$script:Base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
$script:Cooldown = [TimeSpan]::FromMinutes(30)
# A SimplySign login lasts 2 hours. A run may log in again once its last login worked at least this long ago.
$script:Relogin = [TimeSpan]::FromMinutes(90)
$script:DefaultExe = 'C:\Program Files\Certum\SimplySign Desktop\SimplySignDesktop.exe'

function Get-SimplySignFolder {
  if ($env:ISKRA_SIMPLYSIGN_DIR) { return $env:ISKRA_SIMPLYSIGN_DIR }
  $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.local/share' }
  Join-Path $base 'Iskra'
}
function Get-SimplySignSeedPath { Join-Path (Get-SimplySignFolder) 'simplysign.dat' }
function Get-SimplySignLedgerPath { Join-Path (Get-SimplySignFolder) 'simplysign-attempts.json' }

# ── TOTP (RFC 6238) ──

# RFC 4648 Base32 to bytes. Case, spaces, hyphens and '=' padding are ignored, as authenticator apps do.
function ConvertFrom-Base32 {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $clean = ($Text -replace '[\s-]', '').TrimEnd('=').ToUpperInvariant()
  if (-not $clean) { throw 'The seed is empty.' }
  $out = [System.Collections.Generic.List[byte]]::new()
  $bits = 0
  $value = 0
  foreach ($c in $clean.ToCharArray()) {
    $i = $script:Base32Alphabet.IndexOf($c)
    if ($i -lt 0) { throw 'The seed is not Base32 (letters A-Z and digits 2-7).' }
    $value = ($value -shl 5) -bor $i
    $bits += 5
    if ($bits -ge 8) {
      $bits -= 8
      $out.Add([byte](($value -shr $bits) -band 0xff))
    }
    $value = $value -band ((1 -shl $bits) - 1)
  }
  if ($out.Count -lt 10) { throw 'The seed is too short (under 80 bits): copy the whole of it.' }
  , $out.ToArray()
}

# The TOTP code for $Time: HMAC over the 30-second counter, dynamic truncation, $Digits digits.
function Get-Totp {
  param(
    [Parameter(Mandatory)][byte[]]$Secret,
    [DateTimeOffset]$Time = [DateTimeOffset]::UtcNow,
    [ValidateSet('SHA1', 'SHA256', 'SHA512')][string]$Algorithm = 'SHA1',
    [ValidateRange(6, 8)][int]$Digits = 6,
    [ValidateRange(1, 300)][int]$Period = 30
  )
  $counter = [long][Math]::Floor($Time.ToUnixTimeSeconds() / $Period)
  $message = [BitConverter]::GetBytes($counter)
  if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($message) }
  $hmac = switch ($Algorithm) {
    'SHA1' { [System.Security.Cryptography.HMACSHA1]::new($Secret) }
    'SHA256' { [System.Security.Cryptography.HMACSHA256]::new($Secret) }
    'SHA512' { [System.Security.Cryptography.HMACSHA512]::new($Secret) }
  }
  try { $hash = $hmac.ComputeHash($message) } finally { $hmac.Dispose() }
  $offset = $hash[$hash.Length - 1] -band 0x0f
  $binary = (($hash[$offset] -band 0x7f) -shl 24) -bor (($hash[$offset + 1] -band 0xff) -shl 16) -bor (($hash[$offset + 2] -band 0xff) -shl 8) -bor ($hash[$offset + 3] -band 0xff)
  ($binary % [int][Math]::Pow(10, $Digits)).ToString().PadLeft($Digits, '0')
}

# Seconds left before the current code changes.
function Get-TotpSecondsLeft {
  param([DateTimeOffset]$Time = [DateTimeOffset]::UtcNow, [int]$Period = 30)
  $Period - ($Time.ToUnixTimeSeconds() % $Period)
}

# What the owner pasted: an otpauth://totp/... URI (from the QR) or a bare Base32 seed. Returns the TOTP parameters;
# Raw keeps the URI as given for SimplySign's own /otpauth switch.
function ConvertFrom-SeedInput {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
  $t = $Text.Trim()
  if (-not $t) { throw 'Nothing was pasted.' }
  if ($t -notmatch '^otpauth://') {
    $secret = ConvertFrom-Base32 $t
    return [pscustomobject]@{ Secret = $secret; Base32 = ($t -replace '[\s-]', '').TrimEnd('=').ToUpperInvariant(); Algorithm = 'SHA1'; Digits = 6; Period = 30; Account = ''; Issuer = ''; Raw = '' }
  }
  try { $uri = [Uri]$t } catch { throw 'The otpauth:// link is not a valid URI.' }
  if ($uri.Host -ne 'totp') { throw "Only time-based codes (otpauth://totp/...) are supported, not '$($uri.Host)'." }
  $q = @{}
  foreach ($pair in $uri.Query.TrimStart('?').Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
    $k, $v = $pair.Split('=', 2)
    $q[[Uri]::UnescapeDataString($k).ToLowerInvariant()] = if ($null -ne $v) { [Uri]::UnescapeDataString($v.Replace('+', ' ')) } else { '' }
  }
  if (-not $q['secret']) { throw 'The otpauth:// link has no secret= part.' }
  $secret = ConvertFrom-Base32 $q['secret']
  $algorithm = if ($q['algorithm']) { $q['algorithm'].ToUpperInvariant() } else { 'SHA1' }
  if ($algorithm -notin 'SHA1', 'SHA256', 'SHA512') { throw "Unknown algorithm '$algorithm' in the otpauth:// link." }
  $digits = if ($q['digits']) { [int]$q['digits'] } else { 6 }
  if ($digits -lt 6 -or $digits -gt 8) { throw "digits=$digits in the otpauth:// link: 6 to 8 expected." }
  $period = if ($q['period']) { [int]$q['period'] } else { 30 }
  if ($period -lt 1 -or $period -gt 300) { throw "period=$period in the otpauth:// link: 1 to 300 seconds expected." }
  $label = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
  $issuer = if ($q['issuer']) { $q['issuer'] } elseif ($label -match '^([^:]+):') { $Matches[1] } else { '' }
  $account = if ($label -match ':\s*(.+)$') { $Matches[1] } else { $label }
  [pscustomobject]@{ Secret = $secret; Base32 = $q['secret'].ToUpperInvariant().TrimEnd('='); Algorithm = $algorithm; Digits = $digits; Period = $period; Account = $account; Issuer = $issuer; Raw = $t }
}

# ── The stored seed (DPAPI, CurrentUser) ──

function Assert-Dpapi {
  if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw 'DPAPI is Windows only: the SimplySign seed can only be stored on the Windows PC.' }
  Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
}

# Stores the seed for this Windows account. $Seed: ConvertFrom-SeedInput's result. Written atomically.
function Save-SimplySignSeed {
  param([Parameter(Mandatory)]$Seed, [Parameter(Mandatory)][string]$Email, [ValidateSet('dialog', 'switches')][string]$Method = 'dialog', [string]$Path = (Get-SimplySignSeedPath))
  Assert-Dpapi
  if ($Email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw "'$Email' doesn't look like the SimplySign account's e-mail address." }
  $json = [ordered]@{ v = 1; email = $Email; method = $Method; secret = $Seed.Base32; algorithm = $Seed.Algorithm; digits = $Seed.Digits; period = $Seed.Period; uri = $Seed.Raw } | ConvertTo-Json -Compress
  $plain = [Text.Encoding]::UTF8.GetBytes($json)
  try {
    $blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $script:Entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } finally { [Array]::Clear($plain, 0, $plain.Length) }
  $dir = Split-Path $Path -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($tmp, "$script:FileHeader`n$([Convert]::ToBase64String($blob))`n")
  Move-Item -Force -Path $tmp -Destination $Path
}

# The stored seed, or $null when there is none. Throws when the file exists but this account can't read it.
function Read-SimplySignSeed {
  param([string]$Path = (Get-SimplySignSeedPath))
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  Assert-Dpapi
  $lines = @(Get-Content -LiteralPath $Path)
  if ($lines.Count -lt 2 -or $lines[0] -ne $script:FileHeader) { throw "$Path isn't a SimplySign seed file: run scripts/simplysign-setup.ps1 again." }
  try {
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($lines[1]), $script:Entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } catch { throw "$Path can't be read by this Windows account (DPAPI): store the seed again with scripts/simplysign-setup.ps1." }
  try { $d = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json } finally { [Array]::Clear($plain, 0, $plain.Length) }
  [pscustomobject]@{
    Email = $d.email; Method = $(if ($d.method) { $d.method } else { 'dialog' }); Uri = $d.uri
    Secret = ConvertFrom-Base32 $d.secret; Algorithm = $d.algorithm; Digits = [int]$d.digits; Period = [int]$d.period
  }
}

function Remove-SimplySignSeed {
  param([string]$Path = (Get-SimplySignSeedPath))
  $had = Test-Path -LiteralPath $Path
  if ($had) {
    # Overwrite before deleting (best effort on an SSD; DPAPI is the real protection).
    $len = (Get-Item -LiteralPath $Path).Length
    [IO.File]::WriteAllBytes($Path, [byte[]]::new($len))
    Remove-Item -LiteralPath $Path -Force
  }
  $had
}

# ── Attempt ledger: one login per run, a pause after a failure ──

function Read-Ledger([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  try { @((Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).attempts) } catch { @() }
}

# This run's key: the GitHub Actions run and attempt, else scripts/release.ps1's run id, else this process.
function Get-LoginRunKey {
  if ($env:GITHUB_RUN_ID) { return "gh-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)" }
  if ($env:ISKRA_RELEASE_RUN) { return "local-$($env:ISKRA_RELEASE_RUN)" }
  "pid-$PID"
}

# Whether a login may be tried now: @{ Ok; Reason }. One attempt per run. A run that outlasts a SimplySign session
# (2 hours) may log in again only when its last login worked and was at least 90 minutes ago; any other earlier
# attempt in the run (started, failed, not sent, or a login that worked recently) means no.
function Test-LoginAllowed {
  param([string]$RunKey = (Get-LoginRunKey), [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow, [string]$Path = (Get-SimplySignLedgerPath))
  $attempts = Read-Ledger $Path
  $mine = $attempts | Where-Object { $_.key -eq $RunKey } | Select-Object -Last 1
  if ($mine -and -not ($mine.result -eq 'ok' -and ([DateTimeOffset]$mine.at) + $script:Relogin -le $Now)) {
    return @{ Ok = $false; Reason = 'SimplySign already had its one login attempt in this run' }
  }
  $failed = $attempts | Where-Object { $_.result -eq 'failed' } | Sort-Object { [DateTimeOffset]$_.at } | Select-Object -Last 1
  if ($failed) {
    $until = ([DateTimeOffset]$failed.at) + $script:Cooldown
    if ($until -gt $Now) { return @{ Ok = $false; Reason = "the last SimplySign login failed at $(([DateTimeOffset]$failed.at).ToLocalTime().ToString('HH:mm')); no automatic login before $($until.ToLocalTime().ToString('HH:mm')) (so the account can't get locked)" } }
  }
  @{ Ok = $true }
}

# Records an attempt: result 'started' (before the code is sent), then 'ok', 'failed' or 'not-sent'.
function Write-LoginAttempt {
  param([Parameter(Mandatory)][ValidateSet('started', 'ok', 'failed', 'not-sent')][string]$Result, [string]$RunKey = (Get-LoginRunKey), [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow, [string]$Path = (Get-SimplySignLedgerPath))
  $attempts = [System.Collections.Generic.List[object]]::new()
  foreach ($a in (Read-Ledger $Path)) { if ($a.key -ne $RunKey) { $attempts.Add($a) } }
  $attempts.Add([pscustomobject]@{ key = $RunKey; at = $Now.ToString('o'); result = $Result })
  $keep = @($attempts | Select-Object -Last 20)
  New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null
  $tmp = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($tmp, (@{ attempts = $keep } | ConvertTo-Json -Depth 4))
  Move-Item -Force -Path $tmp -Destination $Path
}

# ── SimplySign Desktop ──

function Get-SimplySignExe {
  $p = Get-Process SimplySignDesktop -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p -and $p.Path) { return $p.Path }
  if ($env:ISKRA_SIMPLYSIGN_EXE) { return $env:ISKRA_SIMPLYSIGN_EXE }
  $script:DefaultExe
}

# SimplySign Desktop 7.6.90.0's login dialog is plain Win32 (WinForms) with no UI Automation names, so it's found and
# filled with window messages: the visible window of SimplySignDesktop.exe that has a "Token:" label and an "&Ok"
# button. The ID and token boxes are told apart by which label sits on their row.
$script:Win32 = @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class IskraSimplySignWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w, EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  const uint WM_SETTEXT = 0x000C, WM_GETTEXT = 0x000D, BM_CLICK = 0x00F5;

  public static string Text(IntPtr h) { var s = new StringBuilder(512); SendMessage(h, WM_GETTEXT, (IntPtr)512, s); return s.ToString(); }
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static List<IntPtr> Children(IntPtr w) { var r = new List<IntPtr>(); EnumChildWindows(w, (c, l) => { r.Add(c); return true; }, IntPtr.Zero); return r; }
  static int MidY(IntPtr h) { RECT r; GetWindowRect(h, out r); return (r.Top + r.Bottom) / 2; }

  // [window, id box, token box, ok button], or null.
  public static IntPtr[] FindLogin(int[] pids) {
    IntPtr[] found = null;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, (int)pid) < 0 || !IsWindowVisible(h)) return true;
      IntPtr idLabel = IntPtr.Zero, tokenLabel = IntPtr.Zero, ok = IntPtr.Zero; var edits = new List<IntPtr>();
      foreach (var c in Children(h)) {
        string k = Cls(c), t = Text(c);
        if (k.Contains(".STATIC.") && t == "ID:") idLabel = c;
        else if (k.Contains(".STATIC.") && t == "Token:") tokenLabel = c;
        else if (k.Contains(".BUTTON.") && t.Replace("&", "") == "Ok") ok = c;
        else if (k.Contains(".EDIT.")) edits.Add(c);
      }
      if (idLabel == IntPtr.Zero || tokenLabel == IntPtr.Zero || ok == IntPtr.Zero || edits.Count != 2) return true;
      IntPtr idBox = IntPtr.Zero, tokenBox = IntPtr.Zero;
      foreach (var e in edits) {
        int y = MidY(e);
        if (Math.Abs(y - MidY(idLabel)) < Math.Abs(y - MidY(tokenLabel))) idBox = e; else tokenBox = e;
      }
      if (idBox == IntPtr.Zero || tokenBox == IntPtr.Zero) return true;
      found = new[] { h, idBox, tokenBox, ok };
      return false;
    }, IntPtr.Zero);
    return found;
  }
  public static void SetText(IntPtr h, string t) { SendMessage(h, WM_SETTEXT, IntPtr.Zero, t); }
  public static void Click(IntPtr h) { PostMessage(h, BM_CLICK, IntPtr.Zero, IntPtr.Zero); }
  public static void Close(IntPtr h) { PostMessage(h, 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero); }
}
'@

function Initialize-Win32 {
  if (-not ('IskraSimplySignWin' -as [type])) { Add-Type -TypeDefinition $script:Win32 }
}

# SimplySign Desktop's login dialog as @{ Window; IdBox; TokenBox; Ok } (window handles), or $null.
function Find-LoginForm {
  Initialize-Win32
  $ids = [int[]]@(Get-Process SimplySignDesktop -ErrorAction SilentlyContinue | ForEach-Object Id)
  if (-not $ids.Count) { return $null }
  $h = [IskraSimplySignWin]::FindLogin($ids)
  if (-not $h) { return $null }
  [pscustomobject]@{ Window = $h[0]; IdBox = $h[1]; TokenBox = $h[2]; Ok = $h[3] }
}

# Opens the login dialog: it shows when SimplySign Desktop starts ("show the login dialog on start", its default),
# and when a program asks SimplySign to sign while it isn't logged in. SimplySign isn't logged in when this runs, so
# restarting it loses nothing.
function Open-LoginForm {
  param([int]$TimeoutSeconds = 40)
  $form = Find-LoginForm
  if ($form) { return $form }
  $exe = Get-SimplySignExe
  if (-not (Test-Path -LiteralPath $exe)) { throw "SimplySign Desktop isn't installed ($exe)." }
  Get-Process SimplySignDesktop -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Process -FilePath $exe | Out-Null
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $form = Find-LoginForm
    if ($form) { return $form }
  }
  throw "SimplySign Desktop's login dialog didn't open within $TimeoutSeconds s (SimplySign → options: tick 'show the login dialog on start')."
}

# Fills the dialog (e-mail, then a fresh code) and presses OK. $Code is called right before typing, so the code is
# never one that is about to change.
function Submit-LoginForm {
  param([Parameter(Mandatory)]$Form, [Parameter(Mandatory)][string]$Email, [Parameter(Mandatory)][scriptblock]$Code)
  Initialize-Win32
  if ([IskraSimplySignWin]::Text($Form.IdBox) -ne $Email) { [IskraSimplySignWin]::SetText($Form.IdBox, $Email) }
  [IskraSimplySignWin]::SetText($Form.TokenBox, (& $Code))
  [IskraSimplySignWin]::Click($Form.Ok)
}

# Closes the login dialog (like its close button). Used when the dialog can't be filled automatically, so a signature
# waiting for it fails at once instead of waiting for someone to look at it.
function Close-LoginForm {
  param([Parameter(Mandatory)]$Form)
  Initialize-Win32
  [IskraSimplySignWin]::Close($Form.Window)
}

# Fills the login dialog SimplySign Desktop opened by itself: a program asked it to sign after its session ended (a
# login lasts 2 hours), and that signature now waits for the login. Never restarts SimplySign and never signs anything
# itself, so it can run while the signature waits. Within the ledger's limits (Test-LoginAllowed). Returns
# @{ Code (0 logged in: the dialog closed after the code went in; 2 no seed stored; 3 no attempt allowed now;
# 1 failed); Line }. -ReadSeed, -FindForm and -SubmitForm replace the real ones (tests).
function Invoke-OpenDialogLogin {
  param(
    [scriptblock]$ReadSeed = { Read-SimplySignSeed },
    [scriptblock]$FindForm = { Find-LoginForm },
    [scriptblock]$SubmitForm = { param($form, $email, $code) Submit-LoginForm -Form $form -Email $email -Code $code },
    [int]$TimeoutSeconds = 60, [double]$PollSeconds = 1
  )
  try { $seed = & $ReadSeed } catch { return @{ Code = 1; Line = $_.Exception.Message } }
  if (-not $seed) { return @{ Code = 2; Line = 'no seed stored (scripts/simplysign-setup.ps1); log in by hand' } }
  $allowed = Test-LoginAllowed
  if (-not $allowed.Ok) { return @{ Code = 3; Line = "$($allowed.Reason). Log in to SimplySign Desktop by hand." } }
  $form = & $FindForm
  if (-not $form) { return @{ Code = 1; Line = "SimplySign's login dialog closed before it could be filled" } }
  # Counted from here on.
  Write-LoginAttempt -Result started
  # A code with at least 8 seconds left, so it doesn't change on the way.
  $code = {
    $left = Get-TotpSecondsLeft -Period $seed.Period
    if ($left -lt 8) { Start-Sleep -Seconds ($left + 1) }
    Get-Totp -Secret $seed.Secret -Algorithm $seed.Algorithm -Digits $seed.Digits -Period $seed.Period
  }
  try { & $SubmitForm $form $seed.Email $code } catch {
    Write-LoginAttempt -Result failed
    return @{ Code = 1; Line = "couldn't fill SimplySign's login dialog: $($_.Exception.Message)" }
  }
  # SimplySign closes the dialog once the login works. Two empty looks in a row, so a dialog being redrawn doesn't
  # count as closed.
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $gone = 0
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    if (& $FindForm) { $gone = 0 } elseif (++$gone -ge 2) {
      Write-LoginAttempt -Result ok
      return @{ Code = 0; Line = 'logged in (the login dialog SimplySign opened)' }
    }
  }
  Write-LoginAttempt -Result failed
  @{ Code = 1; Line = "SimplySign's login dialog was still open $TimeoutSeconds s after the code went in" }
}

# For as long as a build runs (scripts/release-windows.ps1 starts it with simplysign-login.ps1 -Watch and stops it
# afterwards): looks for SimplySign's login dialog about once a second and fills it (Invoke-OpenDialogLogin). When it
# can't be filled (no seed, no attempt allowed, the login failed) it closes the dialog, so the waiting signature fails
# and the build stops with the usual line instead of waiting for someone to look. Ends when -ParentPid exits (or after
# -MaxPolls looks, tests). -FindForm, -Login and -CloseForm replace the real ones (tests).
function Watch-LoginDialog {
  param(
    [int]$ParentPid = 0, [double]$PollSeconds = 1, [int]$MaxPolls = 0,
    [scriptblock]$FindForm = { Find-LoginForm },
    [scriptblock]$Login = { Invoke-OpenDialogLogin },
    [scriptblock]$CloseForm = { param($form) Close-LoginForm -Form $form }
  )
  for ($n = 1; ; $n++) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { return }
    if (& $FindForm) {
      $r = & $Login
      Write-Host "SimplySign login: SimplySign asked to log in; $($r.Line)"
      if ($r.Code -ne 0) {
        $still = & $FindForm
        if ($still) { & $CloseForm $still; Write-Host "SimplySign login: closed SimplySign's login dialog, so the signature fails instead of waiting" }
      }
    }
    if ($MaxPolls -and $n -ge $MaxPolls) { return }
    Start-Sleep -Seconds $PollSeconds
  }
}

Export-ModuleMember -Function Get-SimplySignFolder, Get-SimplySignSeedPath, Get-SimplySignLedgerPath, ConvertFrom-Base32, Get-Totp,
  Get-TotpSecondsLeft, ConvertFrom-SeedInput, Save-SimplySignSeed, Read-SimplySignSeed, Remove-SimplySignSeed, Get-LoginRunKey,
  Test-LoginAllowed, Write-LoginAttempt, Get-SimplySignExe, Find-LoginForm, Open-LoginForm, Submit-LoginForm, Close-LoginForm,
  Invoke-OpenDialogLogin, Watch-LoginDialog
