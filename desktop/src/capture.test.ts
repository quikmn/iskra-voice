import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureAppPage, MAX_CAPTURE_SIDE, type CapturableContents } from './capture'

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
