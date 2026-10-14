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
function ps(body) {
  const script = `$ErrorActionPreference = 'Stop'; Import-Module '${module.replaceAll("'", "''")}' -Force\n${body}`
  const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
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
  for (const f of ['release.ps1', 'release-windows.ps1', 'release-checks.psm1', '../desktop/scripts/sign.ps1', '../mobile/scripts/build-android.ps1']) {
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
