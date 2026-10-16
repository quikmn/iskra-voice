import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureAppPage, captureTarget, MAX_CAPTURE_SIDE, parseCaptureTarget, type CapturableContents } from './capture'

function fake(width: number, height: number, options: { empty?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = []
  const picture = (w: number, h: number) => ({
    isEmpty: () => !!options.empty,
    getSize: () => ({ width: w, height: h }),
    resize: (o: { width: number; height: number }) => {
      calls.push(`resize ${o.width}x${o.height}`)
      return picture(o.width, o.height)
    },
    toPNG: () => Buffer.from(`png ${w}x${h}`),
  })
  const contents: CapturableContents = {
    isDestroyed: () => !!options.destroyed,
    capturePage: async () => {
      calls.push('capturePage')
      return picture(width, height)
    },
  }
  return { contents, calls }
}

test('captures the app page itself as a PNG data URL', async () => {
  const { contents, calls } = fake(1280, 800)
  const url = await captureAppPage(contents)
  assert.equal(url, `data:image/png;base64,${Buffer.from('png 1280x800').toString('base64')}`)
  assert.deepEqual(calls, ['capturePage'])
})

test('scales big windows down to the longest side limit', async () => {
  const { contents, calls } = fake(5120, 2880)
  const url = await captureAppPage(contents)
  assert.deepEqual(calls, ['capturePage', `resize ${MAX_CAPTURE_SIDE}x1440`])
  assert.equal(url, `data:image/png;base64,${Buffer.from(`png ${MAX_CAPTURE_SIDE}x1440`).toString('base64')}`)
})

test('nothing for an empty capture or a closed window', async () => {
  assert.equal(await captureAppPage(fake(100, 100, { empty: true }).contents), null)
  const closed = fake(100, 100, { destroyed: true })
  assert.equal(await captureAppPage(closed.contents), null)
  assert.deepEqual(closed.calls, [])
})

test('capture targets: the main window or one of the app’s own pop-outs, never the report window', () => {
  assert.equal(parseCaptureTarget('main'), 'main')
  assert.equal(parseCaptureTarget('iskra-popout-voice-1'), 'iskra-popout-voice-1')
  assert.equal(parseCaptureTarget('iskra-popout-stream-a1'), 'iskra-popout-stream-a1')
  assert.equal(parseCaptureTarget('iskra-popout-chat-z'), 'iskra-popout-chat-z')
  for (const bad of ['iskra-popout-report-1', 'Main', 'screen', 'window:1:0', 'iskra-popout-voice-', 'iskra-popout-voice-1 ', '', null, undefined, 1, {}, ['main']]) {
    assert.equal(parseCaptureTarget(bad), null, String(bad))
  }
})

test('capture targets resolve only to windows that are open', () => {
  const open = new Map([['iskra-popout-voice-1', 'voice page'], ['iskra-popout-report-2', 'report page']])
  const lookup = (name: string) => open.get(name) ?? null
  assert.equal(captureTarget('main', 'main page', lookup), 'main page')
  assert.equal(captureTarget('main', null, lookup), null)
  assert.equal(captureTarget('iskra-popout-voice-1', 'main page', lookup), 'voice page')
  assert.equal(captureTarget('iskra-popout-voice-9', 'main page', lookup), null)
  // Even when it's open, the report window is never a target.
  assert.equal(captureTarget('iskra-popout-report-2', 'main page', lookup), null)
  assert.equal(captureTarget('../../etc', 'main page', lookup), null)
})
