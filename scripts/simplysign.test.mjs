// scripts/simplysign.psm1: TOTP against the RFC 6238 test vectors, Base32 (RFC 4648), otpauth:// links, the DPAPI
// round trip with a fake seed (Windows only), and the attempt ledger (one login per run, a pause after a failure).
// Needs PowerShell 7 (pwsh); skipped where it isn't installed. Never touches the real seed: every test uses its own
// folder (ISKRA_SIMPLYSIGN_DIR).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const module = join(here, 'simplysign.psm1')
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0
const skip = hasPwsh ? false : 'pwsh is not installed'
const skipDpapi = !hasPwsh ? 'pwsh is not installed' : process.platform !== 'win32' ? 'DPAPI is Windows only' : false

function ps(body, env = {}) {
  const script = `$ErrorActionPreference = 'Stop'; Import-Module '${module.replaceAll("'", "''")}' -Force\n${body}`
  return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, ...env } }).trim()
}
const bytes = (ascii) => `([Text.Encoding]::ASCII.GetBytes('${ascii}'))`
const at = (unix) => `([DateTimeOffset]::FromUnixTimeSeconds(${unix}))`

// RFC 6238 Appendix B: the SHA1, SHA256 and SHA512 seeds and the 8-digit codes at each time.
const SEEDS = { SHA1: '12345678901234567890', SHA256: '12345678901234567890123456789012', SHA512: '1234567890123456789012345678901234567890123456789012345678901234' }
const VECTORS = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
]

test('TOTP matches every RFC 6238 test vector (SHA1, SHA256, SHA512, 8 digits)', { skip }, () => {
  const calls = VECTORS.flatMap(([t]) => ['SHA1', 'SHA256', 'SHA512'].map((a) => `(Get-Totp -Secret ${bytes(SEEDS[a])} -Time ${at(t)} -Algorithm ${a} -Digits 8)`))
  const got = ps(`@(${calls.join(', ')}) -join ','`).split(',')
  assert.deepEqual(got, VECTORS.flatMap(([, a, b, c]) => [a, b, c]))
})

test('6-digit codes are the last six digits; seconds left count down to the next code', { skip }, () => {
  assert.equal(ps(`Get-Totp -Secret ${bytes(SEEDS.SHA1)} -Time ${at(59)}`), '287082')
  assert.equal(ps(`Get-Totp -Secret ${bytes(SEEDS.SHA1)} -Time ${at(1111111109)}`), '081804', 'leading zeros kept')
  assert.equal(ps(`Get-TotpSecondsLeft -Time ${at(59)}`), '1')
  assert.equal(ps(`Get-TotpSecondsLeft -Time ${at(60)}`), '30')
})

test('Base32 (RFC 4648): case, spaces, hyphens and padding are ignored; junk and short seeds are refused', { skip }, () => {
  // "12345678901234567890" in Base32.
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  assert.equal(ps(`[Text.Encoding]::ASCII.GetString((ConvertFrom-Base32 '${seed}'))`), SEEDS.SHA1)
  assert.equal(ps(`[Text.Encoding]::ASCII.GetString((ConvertFrom-Base32 'gezd gnbv-gy3t qojq gezd gnbv gy3t qojq'))`), SEEDS.SHA1)
  assert.equal(ps(`[Text.Encoding]::ASCII.GetString((ConvertFrom-Base32 'MZXW6YTBOJUWU23MNU======'))`), 'foobarijklm')
  assert.throws(() => ps(`ConvertFrom-Base32 'GEZDGNBVGY3TQOJ1'`), /not Base32/)
  assert.throws(() => ps(`ConvertFrom-Base32 'MZXW6YTBOI======'`), /too short/)
})

test('otpauth:// links: secret, issuer, account, algorithm, digits and period; a bare seed works too', { skip }, () => {
  const link = 'otpauth://totp/ACME%20Co:john@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60'
  const r = JSON.parse(ps(`$s = ConvertFrom-SeedInput '${link}'; [pscustomobject]@{ Issuer = $s.Issuer; Account = $s.Account; Algorithm = $s.Algorithm; Digits = $s.Digits; Period = $s.Period; Raw = $s.Raw; Code = (Get-Totp -Secret $s.Secret -Time ${at(59)} -Algorithm $s.Algorithm -Digits $s.Digits -Period $s.Period) } | ConvertTo-Json -Compress`))
  assert.deepEqual(r, { Issuer: 'ACME Co', Account: 'john@example.com', Algorithm: 'SHA256', Digits: 8, Period: 60, Raw: link, Code: ps(`Get-Totp -Secret ${bytes(SEEDS.SHA1)} -Time ${at(59)} -Algorithm SHA256 -Digits 8 -Period 60`) })
  const bare = JSON.parse(ps(`$s = ConvertFrom-SeedInput '  GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ '; [pscustomobject]@{ Algorithm = $s.Algorithm; Digits = $s.Digits; Period = $s.Period; Raw = $s.Raw; Code = (Get-Totp -Secret $s.Secret -Time ${at(59)}) } | ConvertTo-Json -Compress`))
  assert.deepEqual(bare, { Algorithm: 'SHA1', Digits: 6, Period: 30, Raw: '', Code: '287082' })
  assert.throws(() => ps(`ConvertFrom-SeedInput 'otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1'`), /Only time-based codes/)
  assert.throws(() => ps(`ConvertFrom-SeedInput 'otpauth://totp/x?issuer=y'`), /no secret= part/)
  assert.throws(() => ps(`ConvertFrom-SeedInput 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=MD5'`), /Unknown algorithm/)
  assert.throws(() => ps(`ConvertFrom-SeedInput ''`), /Nothing was pasted/)
})

test('DPAPI round trip with a fake seed: stored unreadable as text, read back the same, removed', { skip: skipDpapi }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'iskra-simplysign-'))
  try {
    const env = { ISKRA_SIMPLYSIGN_DIR: dir }
    const fake = 'otpauth://totp/Certum:test@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Certum'
    ps(`Save-SimplySignSeed -Seed (ConvertFrom-SeedInput '${fake}') -Email 'test@example.com' -Method switches`, env)
    const file = join(dir, 'simplysign.dat')
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^ISKRA-SIMPLYSIGN-1\n[A-Za-z0-9+/=]+\n$/)
    assert.ok(!text.includes('GEZDGNBV') && !text.includes('example.com'), 'nothing readable in the file')
    const back = JSON.parse(ps(`$s = Read-SimplySignSeed; [pscustomobject]@{ Email = $s.Email; Method = $s.Method; Uri = $s.Uri; Code = (Get-Totp -Secret $s.Secret -Time ${at(59)}) } | ConvertTo-Json -Compress`, env))
    assert.deepEqual(back, { Email: 'test@example.com', Method: 'switches', Uri: fake, Code: '287082' })
    // Another context (different entropy, i.e. not our blob) can't be read as a seed.
    assert.throws(() => ps(`Set-Content -Path '${file.replaceAll("'", "''")}' -Value "ISKRA-SIMPLYSIGN-1\`n$([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([byte[]](1,2,3), $null, 'CurrentUser')))"; Read-SimplySignSeed`, env), /can't be read by this Windows account/)
    assert.equal(ps('Remove-SimplySignSeed', env), 'True')
    assert.ok(!existsSync(file))
    assert.equal(ps('$null -eq (Read-SimplySignSeed)', env), 'True', 'no seed: $null, not an error')
    assert.throws(() => ps(`Save-SimplySignSeed -Seed (ConvertFrom-SeedInput '${fake}') -Email 'not-an-email'`, env), /doesn't look like/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ledger: one login attempt per run, none for 30 minutes after a failure; a code that was never sent does not count', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'iskra-simplysign-'))
  try {
    const env = { ISKRA_SIMPLYSIGN_DIR: dir }
    const allowed = (key, minutes) => ps(`(Test-LoginAllowed -RunKey '${key}' -Now ([DateTimeOffset]'2026-10-15T12:00:00Z').AddMinutes(${minutes})).Ok`, env)
    const write = (key, result, minutes) => ps(`Write-LoginAttempt -Result ${result} -RunKey '${key}' -Now ([DateTimeOffset]'2026-10-15T12:00:00Z').AddMinutes(${minutes})`, env)
    assert.equal(allowed('gh-1-1', 0), 'True')
    write('gh-1-1', 'started', 0)
    assert.equal(allowed('gh-1-1', 1), 'False', 'the same run never tries twice')
    write('gh-1-1', 'ok', 1)
    assert.equal(allowed('gh-1-1', 2), 'False')
    assert.equal(allowed('gh-2-1', 2), 'True', 'the next run may')
    write('gh-2-1', 'failed', 2)
    assert.equal(allowed('gh-3-1', 10), 'False', 'a failure pauses every run')
    assert.match(ps(`(Test-LoginAllowed -RunKey 'gh-3-1' -Now ([DateTimeOffset]'2026-10-15T12:10:00Z')).Reason`, env), /last SimplySign login failed .*no automatic login before/)
    assert.equal(allowed('gh-3-1', 33), 'True', 'after 30 minutes')
    write('gh-3-1', 'not-sent', 33)
    assert.equal(allowed('gh-4-1', 34), 'True', 'nothing was sent: no pause')
    assert.equal(ps("$env:GITHUB_RUN_ID = '77'; $env:GITHUB_RUN_ATTEMPT = '2'; Get-LoginRunKey", env), 'gh-77-2')
    assert.equal(ps("$env:GITHUB_RUN_ID = $null; $env:ISKRA_RELEASE_RUN = 'abc'; Get-LoginRunKey", env), 'local-abc')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the login and setup scripts parse, and never write the seed or a code to output', { skip }, () => {
  for (const f of ['simplysign-login.ps1', 'simplysign-setup.ps1', 'release-pc-checks.ps1']) {
    const out = ps(`$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${join(here, f).replaceAll("'", "''")}', [ref]$null, [ref]$e); @($e).Count`)
    assert.equal(out, '0', `${f} parses`)
  }
  const login = readFileSync(join(here, 'simplysign-login.ps1'), 'utf8')
  assert.ok(!/Write-(Host|Output).*\$(code|seed\.(Secret|Uri))/i.test(login), 'the login script never prints the code or the seed')
  assert.match(login, /Test-LoginAllowed/)
  assert.match(login, /Write-LoginAttempt -Result started/)
})
