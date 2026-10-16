import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  areaFor, DEFAULT_SIZE, isPopoutPage, MIN_SIZE, openBounds, parsePopoutName, parsePopoutPatch, parsePopoutState, popoutWindowOptions, snapBounds,
} from './popouts'
import { isAppPage } from './platform'

const isApp = (url: string) => isAppPage(url, 'app://iskra')
const isAppDev = (url: string) => isAppPage(url, 'app://iskra', 'http://localhost:5173')

test('only named pop-outs of the four kinds', () => {
  assert.deepEqual(parsePopoutName('iskra-popout-voice-1'), { kind: 'voice', name: 'iskra-popout-voice-1' })
  assert.deepEqual(parsePopoutName('iskra-popout-stream-a1b2'), { kind: 'stream', name: 'iskra-popout-stream-a1b2' })
  assert.equal(parsePopoutName('iskra-popout-chat-x')?.kind, 'chat')
  assert.equal(parsePopoutName('iskra-popout-report-1')?.kind, 'report')
  for (const bad of ['', '_blank', 'iskra-popout-voice', 'iskra-popout-admin-1', 'iskra-popout-voice-A', 'iskra-popout-voice-1 ', `iskra-popout-voice-${'a'.repeat(25)}`, 42, null]) {
    assert.equal(parsePopoutName(bad), null, String(bad))
  }
})

test("only the app's own popout.html opens as a pop-out", () => {
  assert.equal(isPopoutPage('app://iskra/popout.html', isApp), true)
  assert.equal(isPopoutPage('http://localhost:5173/popout.html', isAppDev), true)
  assert.equal(isPopoutPage('http://localhost:5173/popout.html', isApp), false)
  assert.equal(isPopoutPage('app://iskra/index.html', isApp), false)
  assert.equal(isPopoutPage('app://iskra/popout.html?x=1', isApp), false)
  assert.equal(isPopoutPage('app://evil/popout.html', isApp), false)
  assert.equal(isPopoutPage('https://example.com/popout.html', isApp), false)
  assert.equal(isPopoutPage('app://user:pw@iskra/popout.html', isApp), false)
  assert.equal(isPopoutPage('not a url', isApp), false)
})

test('remembered state is checked, with defaults', () => {
  const fresh = parsePopoutState(null)
  assert.deepEqual(fresh, {
    voice: { bounds: null, alwaysOnTop: true },
    stream: { bounds: null, alwaysOnTop: true },
    chat: { bounds: null, alwaysOnTop: false },
    report: { bounds: null, alwaysOnTop: true },
  })
  const s = parsePopoutState({
    voice: { bounds: { x: 10.4, y: 20, width: 50, height: 9000 }, alwaysOnTop: false },
    stream: { bounds: { x: 'a', y: 0, width: 1, height: 1 }, alwaysOnTop: 'yes' },
    chat: { bounds: { x: 1, y: 2, width: 300, height: 400 }, alwaysOnTop: true },
    report: { bounds: { x: 0, y: 0, width: 100, height: 100 } },
    extra: { bounds: { x: 0, y: 0, width: 1, height: 1 } },
  })
  // The bug report's form never gets smaller than it fits in.
  assert.deepEqual(s.report, { bounds: { x: 0, y: 0, width: 420, height: 560 }, alwaysOnTop: true })
  assert.deepEqual(s.voice, { bounds: { x: 10, y: 20, width: MIN_SIZE.width, height: 8192 }, alwaysOnTop: false })
  assert.deepEqual(s.stream, { bounds: null, alwaysOnTop: true })
  assert.deepEqual(s.chat, { bounds: { x: 1, y: 2, width: 300, height: 400 }, alwaysOnTop: true })
  assert.equal('extra' in s, false)
})

const primary = { x: 0, y: 0, width: 1920, height: 1040 }
const second = { x: 1920, y: 0, width: 1280, height: 1000 }

test('a new pop-out opens in the bottom-right corner of the main screen', () => {
  assert.deepEqual(openBounds('voice', null, [primary, second]), {
    x: 1920 - DEFAULT_SIZE.voice.width - 16, y: 1040 - DEFAULT_SIZE.voice.height - 16, ...DEFAULT_SIZE.voice,
  })
  // A small screen: never bigger than it.
  const tiny = { x: 0, y: 0, width: 300, height: 200 }
  assert.deepEqual(openBounds('chat', null, [tiny]), { x: 0, y: 0, width: 300, height: 200 })
})

test('a pop-out comes back where it was, if that screen is still there', () => {
  const onSecond = { x: 2500, y: 600, width: 480, height: 300 }
  assert.deepEqual(openBounds('stream', onSecond, [primary, second]), onSecond)
  // The second monitor was unplugged: same size, back in the main screen's corner.
  assert.deepEqual(openBounds('stream', onSecond, [primary]), { x: 1920 - 480 - 16, y: 1040 - 300 - 16, width: 480, height: 300 })
  // Only a sliver left on a screen counts as gone.
  assert.deepEqual(openBounds('voice', { x: 1900, y: 10, width: 280, height: 340 }, [primary]).x, 1920 - 280 - 16)
  // Bigger than its screen now (resolution changed): shrunk to fit.
  assert.deepEqual(openBounds('chat', { x: 0, y: 0, width: 3000, height: 2000 }, [primary]), { x: 0, y: 0, width: 1920, height: 1040 })
})

test('let go near an edge, it snaps; near two, into the corner', () => {
  const b = { x: 0, y: 0, width: 280, height: 340 }
  assert.deepEqual(snapBounds({ ...b, x: 10, y: 500 }, primary), { ...b, x: 0, y: 500 })
  assert.deepEqual(snapBounds({ ...b, x: 1920 - 280 - 20, y: 1040 - 340 + 5 }, primary), { ...b, x: 1640, y: 700 })
  assert.deepEqual(snapBounds({ ...b, x: -12, y: 18 }, primary), { ...b, x: 0, y: 0 })
  assert.deepEqual(snapBounds({ ...b, x: 600, y: 400 }, primary), { ...b, x: 600, y: 400 })
  // On the second screen, its own edges.
  assert.deepEqual(snapBounds({ ...b, x: 1930, y: 1000 - 340 - 3 }, second), { ...b, x: 1920, y: 660 })
})

test('the screen a window is mostly on', () => {
  assert.equal(areaFor({ x: 1800, y: 100, width: 300, height: 200 }, [primary, second]), second)
  assert.equal(areaFor({ x: 1700, y: 100, width: 300, height: 200 }, [primary, second]), primary)
  assert.equal(areaFor({ x: -9000, y: 0, width: 10, height: 10 }, [primary, second]), primary)
})

test('the page may only ask for booleans', () => {
  assert.deepEqual(parsePopoutPatch({ alwaysOnTop: false }), { alwaysOnTop: false })
  assert.deepEqual(parsePopoutPatch({ clickThrough: true, handle: false, other: 'x' }), { clickThrough: true, handle: false })
  assert.deepEqual(parsePopoutPatch({}), {})
  assert.deepEqual(parsePopoutPatch({ focus: true }), { focus: true })
  assert.equal(parsePopoutPatch({ focus: 1 }), null)
  assert.equal(parsePopoutPatch({ alwaysOnTop: 'yes' }), null)
  assert.equal(parsePopoutPatch(null), null)
  assert.equal(parsePopoutPatch('x'), null)
})

test('pop-out windows are frameless, sandboxed and get nothing the main window lacks', () => {
  const base = { icon: 'i.ico', backgroundColor: '#000', preload: '/p/preload.js', spellcheck: true }
  const o = popoutWindowOptions('voice', { bounds: null, alwaysOnTop: true }, { x: 1, y: 2, width: 280, height: 340 }, base)
  assert.equal(o.frame, false)
  assert.equal(o.show, false)
  assert.equal(o.alwaysOnTop, true)
  assert.deepEqual([o.x, o.y, o.width, o.height], [1, 2, 280, 340])
  assert.deepEqual(o.webPreferences, { preload: '/p/preload.js', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true, webviewTag: false })
  assert.equal(popoutWindowOptions('chat', { bounds: null, alwaysOnTop: false }, { x: 0, y: 0, width: 1, height: 1 }, base).alwaysOnTop, false)
  assert.equal(popoutWindowOptions('stream', { bounds: null, alwaysOnTop: true }, { x: 0, y: 0, width: 1, height: 1 }, base).fullscreenable, true)
  const report = popoutWindowOptions('report', { bounds: null, alwaysOnTop: true }, { x: 0, y: 0, width: 440, height: 680 }, base)
  assert.deepEqual([report.minWidth, report.minHeight, report.minimizable, report.fullscreenable], [420, 560, true, false])
})
