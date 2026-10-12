import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkAssets, compareVersions, expectedAssets, formatSums, isValidVersion, missingUpdaterFiles, parseUpdateYml, releaseTitle, replaceVersion } from './release-lib.mjs'

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
  assert.equal(names.length, 22)
  for (const n of ['Iskra-Setup-2.0.0-alpha.10.exe', 'latest-mac.yml', 'iskra-server-2.0.0-alpha.10-win-x64.zip', 'Iskra-2.0.0-alpha.10.apk', 'Iskra-2.0.0-alpha.10-mac-x64.zip']) assert.ok(names.includes(n), n)
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
