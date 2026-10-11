import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aboutDetail, compareVersions, defaultHostRoot, exeName, isAppPage, isWayland, keychainKind, newerRelease, serverRid, skipScreenPicker, trayMenu, updateMode, youTubeReferrer, YOUTUBE_REFERRER } from './platform'

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

test('only the app itself counts as the app page', () => {
  assert.equal(isAppPage('app://iskra/index.html', 'app://iskra'), true)
  assert.equal(isAppPage('app://iskra/', 'app://iskra'), true)
  assert.equal(isAppPage('app://iskra.evil/index.html', 'app://iskra'), false)
  assert.equal(isAppPage('app://other/index.html', 'app://iskra'), false)
  assert.equal(isAppPage('app://x@iskra/', 'app://iskra'), false)
  assert.equal(isAppPage('https://iskra/', 'app://iskra'), false)
  assert.equal(isAppPage('not a url', 'app://iskra'), false)
  assert.equal(isAppPage('http://localhost:5173/#/x', 'app://iskra', 'http://localhost:5173'), true)
  assert.equal(isAppPage('http://localhost:51730/', 'app://iskra', 'http://localhost:5173'), false)
  assert.equal(isAppPage('http://localhost:5173.evil.com/', 'app://iskra', 'http://localhost:5173'), false)
  assert.equal(isAppPage('http://localhost:5173/', 'app://iskra'), false)
})

test('the tray menu follows the updater', () => {
  const labels = (items: ReturnType<typeof trayMenu>) => items.filter((i) => i.action).map((i) => `${i.label}${i.enabled ? '' : ' (off)'}`)
  assert.deepEqual(labels(trayMenu({ state: 'none' }, false, true)), ['Open Iskra', 'About Iskra', 'Check for updates', 'Quit Iskra'])
  assert.deepEqual(labels(trayMenu({ state: 'none' }, true, true))[2], 'Checking for updates… (off)')
  assert.deepEqual(labels(trayMenu({ state: 'none' }, false, false))[2], 'Check for updates (off)') // development builds
  assert.deepEqual(labels(trayMenu({ state: 'downloading', version: '2.1.0' }, false, true))[2], 'Downloading 2.1.0… (off)')
  const ready = trayMenu({ state: 'ready', version: '2.1.0' }, false, true)
  assert.equal(ready.find((i) => i.action === 'restart')?.label, 'Restart to update to 2.1.0')
  const available = trayMenu({ state: 'available', version: '2.1.0', url: 'https://github.com/x' }, false, true)
  assert.equal(available.find((i) => i.action === 'download')?.label, 'Download Iskra 2.1.0')
  assert.equal(trayMenu({ state: 'none' }, false, true).filter((i) => !i.action).length, 2)
})

test('the About box names the version and what Iskra is built on', () => {
  const text = aboutDetail({ app: '2.0.0', electron: '44.4.5', chrome: '140.0', node: '24.1' }, 'darwin', 'arm64')
  assert.match(text, /^Version 2\.0\.0 \(macOS, arm64\)/)
  assert.match(text, /Electron 44\.4\.5/)
  assert.match(text, /PolyForm Noncommercial/)
  assert.match(text, /RNNoise/)
})

test('YouTube embeds get the web app as referrer, only from the app and only for youtube-nocookie.com', () => {
  assert.equal(youTubeReferrer('https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?enablejsapi=1', true), YOUTUBE_REFERRER)
  assert.equal(youTubeReferrer('https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ', false), null)
  assert.equal(youTubeReferrer('https://www.youtube.com/embed/aqz-KE-bpKQ', true), null)
  assert.equal(youTubeReferrer('https://www.youtube-nocookie.com.evil.example/', true), null)
  assert.equal(youTubeReferrer('http://www.youtube-nocookie.com/embed/x', true), null)
  assert.equal(youTubeReferrer('not a url', true), null)
})

test('which keychain protects the stored keys', () => {
  assert.equal(keychainKind('win32', true, null, {}), 'keyring')
  assert.equal(keychainKind('darwin', true, null, {}), 'keyring')
  assert.equal(keychainKind('linux', true, 'gnome_libsecret', {}), 'keyring')
  assert.equal(keychainKind('linux', true, 'kwallet5', {}), 'keyring')
  assert.equal(keychainKind('linux', true, 'basic_text', {}), 'basic')
  assert.equal(keychainKind('linux', false, 'unknown', {}), 'unavailable')
  assert.equal(keychainKind('win32', true, null, { ISKRA_NO_KEYCHAIN: '1' }), 'unavailable')
})
