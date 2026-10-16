import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAssets, ciVerdict, releaseRunCiVerdict, compareVersions, EMPTY_NEXT, expectedAssets, formatSums, isValidVersion, mergeUpdateYml, missingUpdaterFiles, notesFromNext, notesHeadline, parseUpdateYml, publicWordingProblems, releaseTitle, repeatedNotes, replaceVersion } from './release-lib.mjs'

test('accepts x.y.z and x.y.z-alpha.n only', () => {
  for (const v of ['2.0.0', '2.0.0-alpha.10', '10.20.30', '0.0.1-alpha.0']) assert.ok(isValidVersion(v), v)
  for (const v of ['v2.0.0', '2.0', '2.0.0-beta.1', '2.0.0-alpha', '2.0.0-alpha.01', '02.0.0', '2.0.0 ', '2.0.0-alpha.1;rm', '', undefined]) assert.ok(!isValidVersion(v), String(v))
})

test('orders versions like semver', () => {
  assert.ok(compareVersions('2.0.0-alpha.10', '2.0.0-alpha.9') > 0)
  assert.ok(compareVersions('2.0.0', '2.0.0-alpha.99') > 0)
  assert.ok(compareVersions('2.0.1-alpha.1', '2.0.0') > 0)
  assert.equal(compareVersions('2.0.0-alpha.3', '2.0.0-alpha.3'), 0)
  assert.throws(() => compareVersions('nope', '2.0.0'))
})

test('titles', () => {
  assert.equal(releaseTitle('2.0.0-alpha.10'), 'Iskra alpha 10')
  assert.equal(releaseTitle('2.1.0'), 'Iskra 2.1.0')
})

test('replaces every standalone occurrence of the version', () => {
  const html = '<a href="https://github.com/quikmn/iskra-voice/releases/download/v2.0.0-alpha.9/Iskra-Setup-2.0.0-alpha.9.exe">' +
    '<span>v2.0.0-alpha.9</span> Version 2.0.0-alpha.9. Iskra-2.0.0-alpha.9-x86_64.AppImage'
  const { text, count } = replaceVersion(html, '2.0.0-alpha.9', '2.0.0-alpha.10')
  assert.equal(count, 5)
  assert.ok(!text.includes('alpha.9'))
  assert.ok(text.includes('v2.0.0-alpha.10/Iskra-Setup-2.0.0-alpha.10.exe'))
  assert.ok(text.includes('Version 2.0.0-alpha.10.'))
})

test("doesn't touch longer versions that contain the old one", () => {
  const { text, count } = replaceVersion('2.0.0-alpha.1 2.0.0-alpha.10 12.0.0-alpha.1 2.0.0-alpha.1.exe 1.2.0.0-alpha.1', '2.0.0-alpha.1', '2.0.0-alpha.2')
  assert.equal(count, 2)
  assert.equal(text, '2.0.0-alpha.2 2.0.0-alpha.10 12.0.0-alpha.1 2.0.0-alpha.2.exe 1.2.0.0-alpha.1')
})

test('treats the old version literally, not as a pattern', () => {
  assert.equal(replaceVersion('2x0x0', '2.0.0', '3.0.0').count, 0)
})

test('updates links.ts', () => {
  const ts = "export const RELEASE_VERSION = '2.0.0-alpha.9'\nconst x = `v${RELEASE_VERSION}`"
  assert.equal(replaceVersion(ts, '2.0.0-alpha.9', '2.0.0-alpha.10').text.split('\n')[0], "export const RELEASE_VERSION = '2.0.0-alpha.10'")
})

test('expected assets from the spec file', () => {
  const names = expectedAssets('2.0.0-alpha.10').map((a) => a.name)
  assert.equal(names.length, 26)
  for (const n of ['Iskra-Setup-2.0.0-alpha.10.exe', 'latest-mac.yml', 'iskra-server-2.0.0-alpha.10-win-x64.zip', 'Iskra-2.0.0-alpha.10.apk', 'Iskra-2.0.0-alpha.10-mac-x64.zip', 'iskra-server-2.0.0-alpha.10-linux-arm64.tar.gz', 'iskra-sbom-server-2.0.0-alpha.10.cdx.json', 'iskra-sbom-web-2.0.0-alpha.10.cdx.json']) assert.ok(names.includes(n), n)
  // The SBOMs come from release.yml's sbom job; the Windows step waits for its own groups only.
  assert.deepEqual(expectedAssets('2.0.0-alpha.10').filter((a) => a.group === 'sbom').length, 3)
  assert.ok(!names.some((n) => n.includes('{v}')))
})

test('reports missing and unexpected assets', () => {
  const spec = { a: ['x-{v}.exe', 'latest.yml'] }
  const r = checkAssets('1.0.0', ['x-1.0.0.exe', 'SHA256SUMS.txt', 'stray.txt'], spec)
  assert.deepEqual(r.missing, [{ group: 'a', name: 'latest.yml' }])
  assert.deepEqual(r.extra, ['stray.txt'])
})

test('reads latest.yml', () => {
  const yml = "version: 2.0.0-alpha.9\nfiles:\n  - url: Iskra-Setup-2.0.0-alpha.9.exe\n    sha512: abc+/=\n    size: 123\n  - url: b.zip\n    sha512: 'def'\n    size: 4\npath: Iskra-Setup-2.0.0-alpha.9.exe\nsha512: abc+/=\nreleaseDate: '2026-10-11T10:00:00.000Z'\n"
  assert.deepEqual(parseUpdateYml(yml), { version: '2.0.0-alpha.9', files: [{ url: 'Iskra-Setup-2.0.0-alpha.9.exe', sha512: 'abc+/=', size: 123 }, { url: 'b.zip', sha512: 'def', size: 4 }] })
  assert.deepEqual(parseUpdateYml(yml.replaceAll('\n', '\r\n')).files.length, 2)
})

test('update files list what each updater installs from', () => {
  const v = '2.0.0-alpha.12'
  // As published for alpha 12: both Mac zips (plus the dmgs, which the updater ignores).
  const mac = ['Iskra-2.0.0-alpha.12-mac-x64.zip', 'Iskra-2.0.0-alpha.12-mac-arm64.zip', 'Iskra-2.0.0-alpha.12-mac-x64.dmg', 'Iskra-2.0.0-alpha.12-mac-arm64.dmg']
  assert.deepEqual(missingUpdaterFiles('latest-mac.yml', v, mac), [])
  assert.deepEqual(missingUpdaterFiles('latest-mac.yml', v, mac.filter((u) => !u.includes('arm64'))), ['Iskra-2.0.0-alpha.12-mac-arm64.zip'])
  assert.deepEqual(missingUpdaterFiles('latest-linux.yml', v, ['Iskra-2.0.0-alpha.12-amd64.deb']), ['Iskra-2.0.0-alpha.12-x86_64.AppImage'])
  assert.deepEqual(missingUpdaterFiles('latest.yml', v, ['Iskra-Setup-2.0.0-alpha.12.exe']), [])
  assert.deepEqual(missingUpdaterFiles('other.yml', v, []), [])
})

test('SHA256SUMS format', () => {
  assert.equal(formatSums([{ name: 'b', sha256: '22' }, { name: 'B', sha256: '11' }]), '11  B\n22  b\n')
})

// latest-mac.yml as one electron-builder run writes it for both architectures (2.0.0-alpha.12, shortened hashes).
const MAC_BOTH = `version: 2.0.0-alpha.12
files:
  - url: Iskra-2.0.0-alpha.12-mac-x64.zip
    sha512: AAAx
    size: 225004649
  - url: Iskra-2.0.0-alpha.12-mac-arm64.zip
    sha512: BBBa
    size: 213032090
  - url: Iskra-2.0.0-alpha.12-mac-x64.dmg
    sha512: CCCx
    size: 225359687
  - url: Iskra-2.0.0-alpha.12-mac-arm64.dmg
    sha512: DDDa
    size: 213436995
path: Iskra-2.0.0-alpha.12-mac-x64.zip
sha512: AAAx
releaseDate: '2026-10-12T18:41:40.404Z'
`
const MAC_X64 = `version: 2.0.0-alpha.12
files:
  - url: Iskra-2.0.0-alpha.12-mac-x64.zip
    sha512: AAAx
    size: 225004649
  - url: Iskra-2.0.0-alpha.12-mac-x64.dmg
    sha512: CCCx
    size: 225359687
path: Iskra-2.0.0-alpha.12-mac-x64.zip
sha512: AAAx
releaseDate: '2026-10-12T18:41:40.404Z'
`
const MAC_ARM64 = `version: 2.0.0-alpha.12
files:
  - url: Iskra-2.0.0-alpha.12-mac-arm64.zip
    sha512: BBBa
    size: 213032090
  - url: Iskra-2.0.0-alpha.12-mac-arm64.dmg
    sha512: DDDa
    size: 213436995
path: Iskra-2.0.0-alpha.12-mac-arm64.zip
sha512: BBBa
releaseDate: '2026-10-12T18:39:02.001Z'
`

test('merges per-architecture latest-mac.yml into the two-architecture one', () => {
  assert.equal(mergeUpdateYml([MAC_X64, MAC_ARM64]), MAC_BOTH)
  assert.equal(mergeUpdateYml([MAC_X64.replaceAll('\n', '\r\n'), MAC_ARM64]), MAC_BOTH)
  const merged = parseUpdateYml(mergeUpdateYml([MAC_X64, MAC_ARM64]))
  assert.deepEqual(missingUpdaterFiles('latest-mac.yml', '2.0.0-alpha.12', merged.files.map((f) => f.url)), [])
})

test('keeps extra file fields and takes the latest release date', () => {
  const later = MAC_ARM64.replace("'2026-10-12T18:39:02.001Z'", "'2026-10-12T19:00:00.000Z'").replace('    size: 213436995', '    size: 213436995\n    blockMapSize: 1234')
  const merged = mergeUpdateYml([MAC_X64, later])
  assert.ok(merged.includes("releaseDate: '2026-10-12T19:00:00.000Z'"))
  assert.ok(merged.includes('    size: 213436995\n    blockMapSize: 1234\n'))
  assert.ok(merged.includes('path: Iskra-2.0.0-alpha.12-mac-x64.zip\nsha512: AAAx\n'))
})

test('refuses parts that disagree', () => {
  assert.throws(() => mergeUpdateYml([MAC_X64]), /at least two/)
  assert.throws(() => mergeUpdateYml([MAC_X64, MAC_ARM64.replaceAll('alpha.12', 'alpha.13')]), /different versions/)
  assert.throws(() => mergeUpdateYml([MAC_X64, MAC_X64]), /more than one part/)
  assert.throws(() => mergeUpdateYml([MAC_X64, MAC_ARM64.replace('path:', 'minimumSystemVersion: 12.0\npath:')]), /differ/)
  assert.throws(() => mergeUpdateYml([MAC_X64, 'version: 2.0.0-alpha.12\nfiles:\n  - nope\n']), /unexpected/)
})

const PREVIOUS = `**Iskra: alpha 12.**

### What's new
- Old things.

### Get started
- **Windows:** \`Iskra-Setup-2.0.0-alpha.12.exe\`. Not 2.0.0-alpha.120.

### Good to know
- Old notes.
`

test('writes the notes from NEXT.md like the release step', () => {
  const next = "<!-- comment -->\n\n### What's new\n- **A.** One.\n- **B.** Two.\n\n### Fixes\n\n### Good to know\n- Careful.\n"
  assert.equal(notesFromNext(next, '2.0.0-alpha.13', PREVIOUS, '2.0.0-alpha.12'),
    "**Iskra: alpha 13.**\n\n### What's new\n- **A.** One.\n- **B.** Two.\n\n### Get started\n- **Windows:** `Iskra-Setup-2.0.0-alpha.13.exe`. Not 2.0.0-alpha.120.\n\n### Good to know\n- Careful.\n")
  // No "Good to know": Get started goes last.
  assert.ok(notesFromNext("### What's new\n- A.\n", '2.0.0-alpha.13', PREVIOUS, '2.0.0-alpha.12').endsWith('### Get started\n- **Windows:** `Iskra-Setup-2.0.0-alpha.13.exe`. Not 2.0.0-alpha.120.\n'))
  assert.throws(() => notesFromNext(EMPTY_NEXT, '2.0.0-alpha.13', PREVIOUS, '2.0.0-alpha.12'), /no notes/)
  assert.throws(() => notesFromNext("### What's new\n- A.\n", '2.0.0-alpha.13', '**x**\n', '2.0.0-alpha.12'), /Get started/)
})

test('headlines and public wording', () => {
  assert.equal(notesHeadline('2.0.0-alpha.14'), '**Iskra: alpha 14.**')
  assert.equal(notesHeadline('2.1.0'), '**Iskra 2.1.0.**')
  assert.deepEqual(publicWordingProblems('Iskra 2.1.0 is out. LiveKit v1.13.7 inside.'), [])
  assert.equal(publicWordingProblems('Iskra 2 is here').length, 1)
  assert.equal(publicWordingProblems('We rebuilt it').length, 1)
  assert.equal(publicWordingProblems('unlike v1, ').length, 1)
})

test('CI gate verdicts', () => {
  const run = (status, conclusion, event = 'push', n = 1) => ({ status, conclusion, event, html_url: `https://x/runs/${n}` })
  assert.equal(ciVerdict([]).state, 'wait')
  assert.equal(ciVerdict([run('in_progress', null)]).state, 'wait')
  assert.equal(ciVerdict([run('queued', null)]).state, 'wait')
  assert.equal(ciVerdict([run('completed', 'success')]).state, 'pass')
  assert.equal(ciVerdict([run('completed', 'failure', 'push', 2), run('completed', 'success')]).state, 'pass')
  const failed = ciVerdict([run('completed', 'failure', 'push', 2), run('completed', 'cancelled', 'push', 1)])
  assert.equal(failed.state, 'fail')
  assert.match(failed.message, /failure.*runs\/2/)
  // A rerun after a failure: wait for it instead of failing.
  assert.equal(ciVerdict([run('in_progress', null, 'push', 2), run('completed', 'failure')]).state, 'wait')
  // Pull-request runs never count, green or not.
  assert.equal(ciVerdict([run('completed', 'success', 'pull_request')]).state, 'wait')
  assert.equal(ciVerdict([run('completed', 'skipped')]).state, 'fail')
  // A run cancelled by a newer push: fails, with how to get a green run on this commit.
  const cancelled = ciVerdict([run('completed', 'cancelled')])
  assert.equal(cancelled.state, 'fail')
  assert.match(cancelled.message, /cancelled.*gh run rerun/)
})

test('finds notes that already shipped', () => {
  assert.deepEqual(repeatedNotes("### What's new\n- Old things.\n- New things.\n", PREVIOUS), ['- Old things.'])
  assert.deepEqual(repeatedNotes(EMPTY_NEXT, PREVIOUS), [])
})

// ── The Release workflow's own CI (scripts/ci-gate.mjs --run) ──

test("the Release run's CI verdict: every ci / job done, the required ones green", () => {
  const run = { id: 9, path: '.github/workflows/release-all.yml', head_branch: 'main', html_url: 'https://r' }
  const job = (name, conclusion = 'success', status = 'completed') => ({ name: `ci / ${name}`, status, conclusion })
  const all = [job('server (windows-latest)'), job('server (ubuntu-latest)'), job('client (ubuntu-latest)'), job('end-to-end'), job('release scripts and restore drill'), job('android'), job('livekit-mac (arm64)', 'skipped'), job('report to Iskra', 'skipped'), { name: 'windows', status: 'completed', conclusion: 'failure' }]
  assert.equal(releaseRunCiVerdict(run, all).state, 'pass', "other jobs of the run don't count")
  assert.equal(releaseRunCiVerdict(run, [...all, job('desktop (macos-latest)', null, 'in_progress')]).state, 'wait')
  assert.match(releaseRunCiVerdict(run, [...all, job('end-to-end shard 2/4', 'failure')]).message, /end-to-end shard 2\/4 failure/)
  assert.match(releaseRunCiVerdict(run, all.filter((j) => j.name !== 'ci / android')).message, /didn't pass android/)
  assert.match(releaseRunCiVerdict(run, all.map((j) => (j.name === 'ci / end-to-end' ? job('end-to-end', 'skipped') : j))).message, /didn't pass end-to-end/)
  assert.equal(releaseRunCiVerdict({ ...run, path: '.github/workflows/ci.yml' }, all).state, 'fail', 'only the Release workflow')
  assert.equal(releaseRunCiVerdict({ ...run, head_branch: 'feature' }, all).state, 'fail', 'only on main')
  assert.equal(releaseRunCiVerdict(run, []).state, 'fail')
})
