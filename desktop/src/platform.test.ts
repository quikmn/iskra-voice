import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions, defaultHostRoot, exeName, isWayland, newerRelease, serverRid, skipScreenPicker, updateMode } from './platform'

test('server binaries and runtime ids per platform', () => {
  assert.equal(exeName('iskra-server', 'win32'), 'iskra-server.exe')
  assert.equal(exeName('iskra-server', 'linux'), 'iskra-server')
  assert.equal(serverRid('win32', 'x64'), 'win-x64')
  assert.equal(serverRid('linux', 'x64'), 'linux-x64')
  assert.equal(serverRid('darwin', 'arm64'), 'osx-arm64')
  assert.equal(serverRid('darwin', 'x64'), 'osx-x64')
})

test('default host folder per OS', () => {
  const dirs = { documents: 'C:\\Users\\a\\Documents', userData: 'C:\\Users\\a\\AppData\\Roaming\\Iskra' }
  assert.equal(defaultHostRoot('win32', dirs), 'C:\\Users\\a\\Documents\\Iskra\\Servers')
  assert.equal(defaultHostRoot('linux', { documents: '/home/a/Documents', userData: '/home/a/.config/Iskra' }), '/home/a/Documents/Iskra/Servers')
  assert.equal(
    defaultHostRoot('darwin', { documents: '/Users/a/Documents', userData: '/Users/a/Library/Application Support/Iskra' }),
    '/Users/a/Library/Application Support/Iskra/Servers',
  )
})

test('wayland detection and the screen picker', () => {
  assert.equal(isWayland('linux', { XDG_SESSION_TYPE: 'wayland' }), true)
  assert.equal(isWayland('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true)
  assert.equal(isWayland('linux', { XDG_SESSION_TYPE: 'x11' }), false)
  assert.equal(isWayland('win32', { WAYLAND_DISPLAY: 'wayland-0' }), false)
  assert.equal(skipScreenPicker(true, 1), true)
  assert.equal(skipScreenPicker(true, 3), false)
  assert.equal(skipScreenPicker(false, 1), false)
})

test('update mode per package type', () => {
  assert.equal(updateMode('win32', false, {}), 'off')
  assert.equal(updateMode('win32', true, {}), 'auto')
  assert.equal(updateMode('win32', true, { ISKRA_NO_UPDATES: '1' }), 'off')
  assert.equal(updateMode('win32', true, { PORTABLE_EXECUTABLE_DIR: 'C:\\x' }), 'manual')
  assert.equal(updateMode('linux', true, { APPIMAGE: '/home/a/Iskra.AppImage' }), 'auto')
  assert.equal(updateMode('linux', true, {}), 'manual')
  assert.equal(updateMode('darwin', true, {}), 'manual')
})

test('version precedence follows semver', () => {
  const ordered = ['1.1.18', '2.0.0-alpha.2', '2.0.0-alpha.10', '2.0.0-alpha.beta', '2.0.0-beta', '2.0.0-beta.2', '2.0.0-rc.1', '2.0.0', '2.0.1', '2.1.0', '10.0.0']
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(compareVersions(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} < ${ordered[i + 1]}`)
    assert.ok(compareVersions(ordered[i + 1], ordered[i]) > 0, `${ordered[i + 1]} > ${ordered[i]}`)
  }
  assert.equal(compareVersions('v2.0.0-alpha.2', '2.0.0-alpha.2'), 0)
  assert.ok(compareVersions('v1.1.18.3', '2.0.0') < 0) // old four-part tags never win
})

test('newer release ignores drafts, odd tags and older versions', () => {
  const r = (tag: string, draft = false) => ({ tag_name: tag, html_url: `https://github.com/quikmn/iskra-voice/releases/tag/${tag}`, draft })
  const releases = [r('v2.0.0-alpha.4', true), r('v2.0.0-alpha.3'), r('v2.0.0-alpha.1'), r('v1.1.18.3'), r('nightly')]
  assert.deepEqual(newerRelease(releases, '2.0.0-alpha.2'), { version: '2.0.0-alpha.3', url: releases[1].html_url })
  assert.equal(newerRelease(releases, '2.0.0-alpha.3'), null)
  assert.equal(newerRelease([{ ...r('v9.0.0'), html_url: 'https://evil.example/x' }], '2.0.0'), null)
})
