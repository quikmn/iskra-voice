// scripts/release-checks.psm1 (SimplySign's test signature, Android prerequisites) with fakes, and a parse check of
// the PowerShell release scripts. Needs PowerShell 7 (pwsh); skipped where it isn't installed.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const module = join(here, 'release-checks.psm1')
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0
const skip = hasPwsh ? false : 'pwsh is not installed'

// Runs a PowerShell snippet with the module loaded; returns its JSON output.
function ps(body, env = {}) {
  const script = `$ErrorActionPreference = 'Stop'; Import-Module '${module.replaceAll("'", "''")}' -Force\n${body}`
  // Run as on the PC (the login line differs inside GitHub Actions), unless a test says otherwise.
  const base = { ...process.env }
  delete base.GITHUB_ACTIONS
  const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...base, ...env } })
  return JSON.parse(out)
}

const fakeCert = (days, { subject = 'CN=Open Source Developer Viktor Lundgren, O=Open Source Developer', eku = '1.3.6.1.5.5.7.3.3', key = true } = {}) =>
  `[pscustomobject]@{ HasPrivateKey = $${key}; Subject = '${subject}'; EnhancedKeyUsageList = @([pscustomobject]@{ ObjectId = '${eku}' }); NotAfter = (Get-Date '2026-10-15').AddDays(${days}) }`
const now = "-Now (Get-Date '2026-10-15')"
const result = '| Select-Object Ok, Reason, Message, ExpiresSoon | ConvertTo-Json -Compress'
const wrap = (expr) => `$r = ${expr}; [pscustomobject]$r ${result}`

test('signing works with a valid certificate and a signer that signs', { skip }, () => {
  const r = ps(wrap(`Test-Signing -Certificates @(${fakeCert(200)}) -Signer { param($f, $c) @{ Status = 'Valid' } } ${now}`))
  assert.equal(r.Ok, true)
  assert.equal(r.ExpiresSoon, false)
  assert.match(r.Message, /signing works .*valid until 2027-05-03/)
})

test('no certificate in the store: SimplySign is logged out, with the one login line', { skip }, () => {
  const others = [fakeCert(200, { subject: 'CN=Someone Else' }), fakeCert(200, { eku: '1.3.6.1.5.5.7.3.1' }), fakeCert(200, { key: false })].join(', ')
  const r = ps(wrap(`Test-Signing -Certificates @(${others}) -Signer { throw 'must not sign' } ${now}`))
  assert.equal(r.Ok, false)
  assert.equal(r.Reason, 'no-cert')
  assert.match(r.Message, /Log in to SimplySign Desktop \(6-digit code from the app\), then run scripts\/release\.ps1 again\.$/)
})

test('an expired certificate is its own problem (renew, not log in)', { skip }, () => {
  const r = ps(wrap(`Test-Signing -Certificates @(${fakeCert(-1)}) -Signer { throw 'must not sign' } ${now}`))
  assert.equal(r.Reason, 'expired')
  assert.match(r.Message, /expired on 2026-10-14.*Renew/)
})

test('the test signature failing (SimplySign session gone) or throwing is a login problem', { skip }, () => {
  const bad = ps(wrap(`Test-Signing -Certificates @(${fakeCert(200)}) -Signer { param($f, $c) @{ Status = 'UnknownError'; StatusMessage = 'The specified PIN is incorrect' } } ${now}`))
  assert.equal(bad.Reason, 'sign-failed')
  assert.match(bad.Message, /PIN is incorrect.*Log in to SimplySign Desktop/)
  const thrown = ps(wrap(`Test-Signing -Certificates @(${fakeCert(200)}) -Signer { throw 'No provider was specified' } ${now}`))
  assert.equal(thrown.Reason, 'sign-failed')
  assert.match(thrown.Message, /No provider was specified/)
})

test('the newest matching certificate is used, and an expiry within 30 days is flagged', { skip }, () => {
  const r = ps(wrap(`Test-Signing -Certificates @(${fakeCert(-10)}, ${fakeCert(20)}) -Signer { param($f, $c) if (-not (Test-Path $f)) { throw 'no probe file' }; @{ Status = 'Valid' } } ${now}`))
  assert.equal(r.Ok, true)
  assert.equal(r.ExpiresSoon, true)
})

// Confirm-Signing: the test signature, then the automatic SimplySign login once (fakes for both).
const okTest = "{ @{ Ok = $true; Message = 'signing works (x)' } }"
const noCertTest = `{ @{ Ok = $false; Reason = 'no-cert'; Message = "SimplySign isn't logged in. $(Get-SimplySignLoginLine)" } }`
const confirm = (test, login, env) => ps(`$r = Confirm-Signing -Test ${test} -Login ${login}; [pscustomobject]$r | Select-Object Ok, Reason, Message, AutoLogin | ConvertTo-Json -Compress`, env)

test('Confirm-Signing: signing works, so no login is tried', { skip }, () => {
  const r = confirm(okTest, "{ throw 'must not log in' }")
  assert.equal(r.Ok, true)
  assert.equal(r.AutoLogin, null)
})

test("Confirm-Signing: no seed stored keeps today's line (log in by hand); an expired certificate never tries a login", { skip }, () => {
  const r = confirm(noCertTest, "{ @{ Code = 2; Line = 'no seed stored' } }")
  assert.equal(r.Ok, false)
  assert.match(r.Message, /Log in to SimplySign Desktop \(6-digit code from the app\), then run scripts\/release\.ps1 again\.$/)
  const expired = confirm("{ @{ Ok = $false; Reason = 'expired'; Message = 'expired on 2026-10-14' } }", "{ throw 'must not log in' }")
  assert.equal(expired.Reason, 'expired')
})

test('Confirm-Signing: the login works, the second test signature passes', { skip }, () => {
  const r = confirm("{ if ($script:n++) { @{ Ok = $true; Message = 'signing works (x)' } } else { @{ Ok = $false; Reason = 'no-cert'; Message = 'not logged in' } } }", "{ @{ Code = 0; Line = 'logged in (dialog)' } }")
  assert.equal(r.Ok, true)
  assert.equal(r.AutoLogin, true)
  assert.match(r.Message, /SimplySign logged itself in$/)
})

test('Confirm-Signing: a failed or refused login says why, with the line to log in by hand (on GitHub: re-run)', { skip }, () => {
  const failed = confirm(noCertTest, `{ @{ Code = 1; Line = "the login (dialog) didn't work within 90 s" } }`)
  assert.equal(failed.Ok, false)
  assert.match(failed.Message, /automatic login didn't help \(the login \(dialog\) didn't work within 90 s\)\. Log in to SimplySign Desktop/)
  const once = confirm(noCertTest, "{ @{ Code = 3; Line = 'SimplySign already had its one login attempt in this run' } }", { GITHUB_ACTIONS: 'true' })
  assert.match(once.Message, /one login attempt in this run.*on the home PC .*re-run the failed jobs of this Release run\.$/)
  const still = confirm("{ @{ Ok = $false; Reason = 'sign-failed'; Message = 'still no' } }", "{ @{ Code = 0; Line = 'logged in' } }")
  assert.match(still.Message, /^SimplySign logged in, but the test signature still fails: still no/)
})

test('Confirm-Signing: after the probe handled a login dialog or timed out, no second login is tried', { skip }, () => {
  for (const reason of ['login-dialog', 'sign-timeout']) {
    const r = confirm(`{ @{ Ok = $false; Reason = '${reason}'; Message = 'x' } }`, "{ throw 'must not log in' }")
    assert.equal(r.Reason, reason)
  }
})

// Invoke-SigningProbe: the test signature in a child process with a time limit, filling SimplySign's login dialog when
// it shows (fakes for the signature, the dialog, the fill and the close; never the real SimplySign).
function probe({ test: t, find = '{ $null }', fill = "{ throw 'must not fill' }", close = "{ throw 'must not close' }", timeout = 20 }) {
  const dir = mkdtempSync(join(tmpdir(), 'iskra-probe-'))
  const flag = join(dir, 'flag'), pidFile = join(dir, 'pid')
  try {
    const r = ps(`$script:closed = 0; $script:filled = 0
$r = Invoke-SigningProbe -Test ${t} -FindDialog ${find} -Fill ${fill} -CloseDialog ${close} -TimeoutSeconds ${timeout} -LoginSeconds 20 -PollSeconds 0.2
$childAlive = $false
if (Test-Path $env:ISKRA_TEST_PID) { $childAlive = [bool](Get-Process -Id ([int](Get-Content $env:ISKRA_TEST_PID)) -ErrorAction SilentlyContinue) }
[pscustomobject]@{ Ok = $r.Ok; Reason = $r.Reason; Message = $r.Message; AutoLogin = $r.AutoLogin; Filled = $script:filled; Closed = $script:closed; ChildAlive = $childAlive; PidSeen = (Test-Path $env:ISKRA_TEST_PID); NotAfter = $(if ($r.Certificate) { $r.Certificate.NotAfter.ToString('yyyy-MM-dd') }) } | ConvertTo-Json -Compress`,
    { ISKRA_TEST_FLAG: flag, ISKRA_TEST_PID: pidFile })
    return r
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const blockUntilFlag = "{ Set-Content $env:ISKRA_TEST_PID $PID; while (-not (Test-Path $env:ISKRA_TEST_FLAG)) { Start-Sleep -Milliseconds 100 }; @{ Ok = $true; Message = 'signing works (x)' } }"
const blockForever = '{ Set-Content $env:ISKRA_TEST_PID $PID; Start-Sleep -Seconds 600 }'

test('probe: a fast signature returns as before, certificate included, no dialog filled', { skip }, () => {
  const r = probe({ test: `{ Test-Signing -Certificates @(${fakeCert(200)}) -Signer { param($f, $c) @{ Status = 'Valid' } } ${now} }` })
  assert.equal(r.Ok, true)
  assert.equal(r.AutoLogin, null)
  assert.equal(r.Filled, 0)
  assert.equal(r.NotAfter, '2027-05-03')
  assert.match(r.Message, /signing works/)
})

test('probe: the signature waits on SimplySign\'s login dialog, the dialog is filled once, the signature finishes', { skip }, () => {
  // The dialog shows once the signature has started; filling it lets the waiting signature finish.
  const r = probe({
    test: blockUntilFlag,
    find: "{ if (Test-Path $env:ISKRA_TEST_PID) { 'dialog' } }",
    fill: "{ $script:filled++; Set-Content $env:ISKRA_TEST_FLAG 'x'; @{ Code = 0; Line = 'logged in' } }",
  })
  assert.equal(r.Ok, true)
  assert.equal(r.AutoLogin, true)
  assert.equal(r.Filled, 1)
  assert.match(r.Message, /SimplySign logged itself in$/)
})

test('probe: a signature that never finishes and no dialog times out with a clear line; the child is stopped', { skip }, () => {
  const r = probe({ test: blockForever, timeout: 6 })
  assert.equal(r.Ok, false)
  assert.equal(r.Reason, 'sign-timeout')
  assert.match(r.Message, /didn't finish within 6 s and SimplySign showed no login dialog .*Log in to SimplySign Desktop/)
  assert.equal(r.PidSeen, true, "the child had started signing")
  assert.equal(r.ChildAlive, false)
})

test('probe: the ledger forbids a login (or no seed): nothing filled, the dialog closed, the child stopped, a clear line', { skip }, () => {
  const refused = probe({
    test: blockForever,
    find: "{ if (Test-Path $env:ISKRA_TEST_PID) { 'dialog' } }",
    fill: "{ @{ Code = 3; Line = 'SimplySign already had its one login attempt in this run. Log in to SimplySign Desktop by hand.' } }",
    close: '{ $script:closed++ }',
  })
  assert.equal(refused.Ok, false)
  assert.equal(refused.Reason, 'login-dialog')
  assert.match(refused.Message, /^SimplySign's session ended \(it asked to log in\) and the automatic login didn't help \(SimplySign already had its one login attempt in this run\..*\)\. Log in to SimplySign Desktop \(6-digit code from the app\), then run scripts\/release\.ps1 again\.$/)
  assert.equal(refused.Closed, 1)
  assert.equal(refused.PidSeen, true)
  assert.equal(refused.ChildAlive, false)
  const noSeed = probe({ test: blockForever, find: "{ 'dialog' }", fill: "{ @{ Code = 2; Line = 'no seed stored' } }", close: '{ $script:closed++ }' })
  assert.match(noSeed.Message, /and no seed is stored\. Log in to SimplySign Desktop/)
  assert.equal(noSeed.Closed, 1)
})

test("installed Windows apps accept updates signed by today's and a future publisher (electron-updater publisherName)", () => {
  const pkg = JSON.parse(readFileSync(join(here, '../desktop/package.json'), 'utf8'))
  const names = pkg.build.win.signtoolOptions.publisherName
  assert.ok(Array.isArray(names))
  assert.equal(names[0], pkg.build.win.signtoolOptions.certificateSubjectName, "today's certificate first")
  assert.ok(names.includes('CN=Viktor Lundgren, C=SE'), "a future certificate in the owner's own name, pinned to Sweden (a DN, so the country must match too)")
  assert.match(readFileSync(join(here, 'release-checks.psm1'), 'utf8'), new RegExp(`Subject = '${names[0]}'`))
})

test('Android prerequisites: all there, then each missing one named (presence only)', { skip }, () => {
  const dev = mkdtempSync(join(tmpdir(), 'iskra-android-'))
  try {
    mkdirSync(join(dev, 'devtools', 'jdk-21'), { recursive: true })
    writeFileSync(join(dev, 'devtools', 'jdk-21', 'release'), 'JAVA_VERSION="21.0.4"\n')
    mkdirSync(join(dev, 'devtools', 'android-sdk', 'build-tools', '36.1.0'), { recursive: true })
    mkdirSync(join(dev, 'devkeys'))
    writeFileSync(join(dev, 'devkeys', 'iskra-android.keystore'), 'fake')
    writeFileSync(join(dev, 'devkeys', 'iskra-android-keystore.txt'), 'fake')
    const check = (env = '@{}') => ps(`ConvertTo-Json -Compress -InputObject @(Get-AndroidProblems -DevRoot '${dev}' -Environment ${env} -JdkInstalls @())`)
    assert.deepEqual(check(), [])
    rmSync(join(dev, 'devkeys', 'iskra-android-keystore.txt'))
    assert.deepEqual(check("@{ ISKRA_ANDROID_KEYSTORE_PASSWORD = 'x' }"), [], 'a password in the environment needs no file')
    const p = check()
    assert.equal(p.length, 1)
    assert.match(p[0], /keystore password file/)
    rmSync(join(dev, 'devtools', 'android-sdk', 'build-tools'), { recursive: true })
    writeFileSync(join(dev, 'devtools', 'jdk-21', 'release'), 'JAVA_VERSION="17.0.1"\n')
    rmSync(join(dev, 'devkeys', 'iskra-android.keystore'))
    const all = check("@{ JAVA_HOME = '' }").join('\n')
    assert.match(all, /No JDK 21/)
    assert.match(all, /build-tools 36\.1\.0/)
    assert.match(all, /release keystore/)
  } finally { rmSync(dev, { recursive: true, force: true }) }
})

test('the PowerShell release scripts parse', { skip }, () => {
  for (const f of ['release.ps1', 'release-windows.ps1', 'release-checks.psm1', 'release-pc-checks.ps1', 'simplysign.psm1', 'simplysign-login.ps1', 'simplysign-setup.ps1', 'runner-setup.ps1', 'runner-job-guard.ps1', '../desktop/scripts/sign.ps1', '../mobile/scripts/build-android.ps1']) {
    const path = join(here, f).replaceAll("'", "''")
    const errors = ps(`$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$e); ConvertTo-Json -Compress -InputObject @($e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" })`)
    assert.deepEqual(errors, [], f)
  }
})

test('release.ps1 asks nothing interactively', () => {
  const text = readFileSync(join(here, 'release.ps1'), 'utf8')
  for (const bad of ['Read-Host', 'approve it', 'PromptForChoice', 'Get-Credential']) assert.ok(!text.includes(bad), bad)
  assert.ok(text.includes("GH_PROMPT_DISABLED = '1'") && text.includes("GIT_TERMINAL_PROMPT = '0'"))
  assert.ok(text.includes('ALL CHECKS GREEN - SENDING'))
})
