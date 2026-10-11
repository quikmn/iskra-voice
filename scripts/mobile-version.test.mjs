import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNumber, marketingVersion, versionCode } from './mobile-version.mjs'

test('version codes match the Android app', () => {
  assert.equal(versionCode('2.0.0-alpha.7'), 20000107)
  assert.equal(versionCode('2.0.0-beta.2'), 20000202)
  assert.equal(versionCode('2.0.0-rc.1'), 20000301)
  assert.equal(versionCode('2.0.0'), 20000900)
  assert.equal(versionCode('2.1.3'), 20103900)
})

test('every release orders after the last', () => {
  const order = ['2.0.0-alpha.9', '2.0.0-alpha.10', '2.0.0-beta.1', '2.0.0-rc.2', '2.0.0', '2.0.1-alpha.1', '2.1.0', '3.0.0-alpha.1']
  for (let i = 1; i < order.length; i++) assert.ok(versionCode(order[i]) > versionCode(order[i - 1]), order[i])
})

test('marketing version is the numeric part', () => {
  assert.equal(marketingVersion('2.0.0-alpha.9'), '2.0.0')
  assert.equal(marketingVersion('2.10.3'), '2.10.3')
})

test('build numbers add the run, so rebuilds still go up', () => {
  assert.equal(buildNumber('2.0.0-alpha.9', 41, 1), '20000109.41.1')
  assert.equal(buildNumber('2.0.0-alpha.9', '41', '2'), '20000109.41.2')
})

test('rejects what it cannot number', () => {
  for (const v of ['2.0', 'v2.0.0', '2.0.0-alpha.100', '2.100.0', '2.0.0-preview.1', '', undefined]) assert.throws(() => versionCode(v), String(v))
  assert.throws(() => buildNumber('2.0.0', -1))
  assert.throws(() => buildNumber('2.0.0', '1;rm'))
})

test('the Android build reads its version code from the CLI', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const version = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8')).version
  const out = execFileSync(process.execPath, [new URL('./mobile-version.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--android'], { encoding: 'utf8' })
  assert.equal(out, `APP_VERSION=${version}\nVERSION_CODE=${versionCode(version)}\n`)
})
