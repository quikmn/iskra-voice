import { describe, expect, it } from 'vitest'
import { encodePlan, fitSize, MAX_SIDE } from './images'
import { base64Bytes, buildPayload, canSend, emptyDraft, MAX_WHAT, platformInfo, previewPayload, reportFiles, STEPS_TEMPLATE, validEmail, type ReportEnv } from './payload'
import { BugSendError, sendBugReport } from './send'
import { crc32, makeZip } from './zip'

const env: ReportEnv = { version: '2.0.0-alpha.15', commit: 'abc1234', os: 'Linux', device: 'web' }
const image = { type: 'image/png' as const, data: btoa('fake png bytes'), bytes: 14, width: 10, height: 10 }

describe('the form', () => {
  it('needs what happened, a sane email and at most five pictures', () => {
    expect(canSend(emptyDraft())).toBe(false)
    expect(canSend({ ...emptyDraft(), what: '   ' })).toBe(false)
    expect(canSend({ ...emptyDraft(), what: 'It crashed' })).toBe(true)
    expect(canSend({ ...emptyDraft(), what: 'x'.repeat(MAX_WHAT + 1) })).toBe(false)
    expect(canSend({ ...emptyDraft(), what: 'x', email: 'nope' })).toBe(false)
    expect(canSend({ ...emptyDraft(), what: 'x', email: 'me@example.com' })).toBe(true)
    expect(canSend({ ...emptyDraft(), what: 'x', images: Array(6).fill(image) })).toBe(false)
    expect(validEmail(' me@example.com ')).toBe(true)
    expect(validEmail('me@localhost')).toBe(false)
  })

  it('sends only what was filled in; untouched steps and logs left off say nothing', () => {
    const payload = buildPayload({ ...emptyDraft(), what: '  It crashed  ', includeLogs: false }, env, 'the logs')
    expect(payload).toEqual({ v: 1, what: 'It crashed', env })
    expect(emptyDraft().steps).toBe(STEPS_TEMPLATE)

    const full = buildPayload({ what: 'x', steps: '1. Open\n2. Click\n3. ', expected: 'y', email: 'me@example.com', includeLogs: true, images: [image] }, env, 'the logs')
    expect(full).toEqual({ v: 1, what: 'x', steps: '1. Open\n2. Click\n3.', expected: 'y', email: 'me@example.com', env, logs: 'the logs', images: [{ type: 'image/png', data: image.data }] })
  })

  it('previews exactly the payload, with image bytes summarised', () => {
    const payload = buildPayload({ ...emptyDraft(), what: 'x', images: [image] }, env, 'log line')
    const preview = JSON.parse(previewPayload(payload))
    expect(preview.what).toBe('x')
    expect(preview.logs).toBe('log line')
    expect(preview.images).toEqual([{ type: 'image/png', data: '<image 1: 0 KB>' }])
    expect(preview.env).toEqual(env)
    expect(base64Bytes(btoa('abcd'))).toBe(4)
  })
})

describe('the environment', () => {
  it('names the OS and browser coarsely, never the full user agent', () => {
    expect(platformInfo('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36'))
      .toEqual({ os: 'Windows', browser: 'Chrome 140' })
    expect(platformInfo('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Iskra/2.0.0 Chrome/140.0.0.0 Electron/44.0.0 Safari/537.36'))
      .toEqual({ os: 'macOS', browser: 'Electron 44' })
    expect(platformInfo('Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1'))
      .toEqual({ os: 'iOS 18.2', browser: 'Safari 18' })
    expect(platformInfo('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'))
      .toEqual({ os: 'Android 15', browser: 'Chrome 140' })
    expect(platformInfo('Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0')).toEqual({ os: 'Linux', browser: 'Firefox 141' })
  })
})

describe('screenshots', () => {
  it('fit within the size limit and never grow', () => {
    expect(fitSize(5120, 2880)).toEqual({ width: MAX_SIDE, height: 1440 })
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitSize(1000, 4000, 2000)).toEqual({ width: 500, height: 2000 })
  })

  it('try lossless first, then smaller encodings and sizes', () => {
    const plan = encodePlan(3000, 2000)
    expect(plan[0]).toEqual({ type: 'image/png', width: 2560, height: 1707 })
    expect(plan[1].type).toBe('image/webp')
    expect(plan[2].type).toBe('image/jpeg')
    expect(plan.at(-1)!.width).toBeLessThan(1000)
  })
})

describe('saving as a file', () => {
  it('writes a zip with report.json, the logs and the pictures', () => {
    const payload = buildPayload({ ...emptyDraft(), what: 'x', images: [image] }, env, 'logs here')
    const files = reportFiles(payload)
    expect(files.map((f) => f.name)).toEqual(['report.json', 'logs.txt', 'screenshot-1.png'])
    expect(JSON.parse(new TextDecoder().decode(files[0].data)).images).toBeUndefined()
    expect(new TextDecoder().decode(files[2].data)).toBe('fake png bytes')

    const zip = makeZip(files, new Date(2026, 9, 14, 12, 0, 0))
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    const end = zip.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(3)
    // The first file's CRC and contents are where the header says.
    const nameLength = view.getUint16(26, true)
    const size = view.getUint32(18, true)
    const data = zip.slice(30 + nameLength, 30 + nameLength + size)
    expect(view.getUint32(14, true)).toBe(crc32(data))
    expect(new TextDecoder().decode(zip.slice(30, 30 + nameLength))).toBe('report.json')
  })

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('hello'))).toBe(0x3610a686)
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('sending', () => {
  const payload = buildPayload({ ...emptyDraft(), what: 'x' }, env, null)
  const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })

  it('posts JSON without cookies and returns the report id', async () => {
    const calls: [string, RequestInit][] = []
    const result = await sendBugReport(payload, {
      url: 'https://inbox.test/bug-reports',
      fetch: (async (url: string, init: RequestInit) => { calls.push([url, init]); return reply(201, { id: 'ABCD-EF23' }) }) as unknown as typeof fetch,
    })
    expect(result).toEqual({ id: 'ABCD-EF23' })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('https://inbox.test/bug-reports')
    expect(calls[0][1].method).toBe('POST')
    expect(calls[0][1].credentials).toBe('omit')
    expect(JSON.parse(calls[0][1].body as string)).toEqual(payload)
  })

  it('retries network trouble and server errors, then gives up as offline', async () => {
    let tries = 0
    const waits: number[] = []
    const fail = sendBugReport(payload, {
      url: 'https://inbox.test/x', backoff: [10, 20], sleep: async (ms) => { waits.push(ms) },
      fetch: (async () => { tries++; throw new TypeError('Failed to fetch') }) as unknown as typeof fetch,
    })
    await expect(fail).rejects.toEqual(new BugSendError('offline'))
    expect(tries).toBe(3)
    expect(waits).toEqual([10, 20])

    let attempts = 0
    const recovered = await sendBugReport(payload, {
      url: 'https://inbox.test/x', backoff: [1], sleep: async () => undefined,
      fetch: (async () => (++attempts === 1 ? reply(503) : reply(201, { id: 'WXYZ-2345' }))) as unknown as typeof fetch,
    })
    expect(recovered.id).toBe('WXYZ-2345')
  })

  it("doesn't retry what retrying can't fix", async () => {
    for (const [status, reason] of [[429, 'rate'], [404, 'off'], [413, 'tooLarge'], [400, 'invalid']] as const) {
      let tries = 0
      await expect(sendBugReport(payload, {
        url: 'https://inbox.test/x', sleep: async () => undefined,
        fetch: (async () => { tries++; return reply(status) }) as unknown as typeof fetch,
      })).rejects.toEqual(new BugSendError(reason))
      expect(tries).toBe(1)
    }
  })
})
