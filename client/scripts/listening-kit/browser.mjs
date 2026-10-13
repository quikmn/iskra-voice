// The parts of a call only a browser has: Chromium's own mic processing (echo cancellation, noise suppression and
// automatic gain, as getUserMedia applies them) and Opus. Uses Playwright's Chromium, headless; the fake mic plays a
// WAV file (Chromium's --use-file-for-fake-audio-capture). Pages are served from memory: nothing listens on the
// network and nothing is fetched.
import { chromium } from '@playwright/test'

const ORIGIN = 'https://listening-kit.invalid/'

const f32ToBase64 = (x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('base64')
const base64ToF32 = (s) => {
  const b = Buffer.from(s, 'base64')
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}

async function open(args = []) {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...args] })
  const page = await browser.newPage()
  await page.route(`${ORIGIN}**`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>kit</title>' }))
  await page.goto(ORIGIN)
  return { browser, page }
}

/**
 * Records what the app's AudioContext gets from the mic for these capture settings, while the fake mic plays `wav`
 * once (48 kHz). Starts with whatever start-up delay the browser has; the caller aligns.
 */
export async function capture(wav, constraints, seconds) {
  const { browser, page } = await open([`--use-file-for-fake-audio-capture=${wav}%noloop`])
  try {
    const out = await page.evaluate(async ({ constraints, seconds }) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      const track = stream.getAudioTracks()[0]
      // The track's own frames, as the capture (and the browser's processing) hands them on: no second clock.
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
      const chunks = []
      let rate = 0
      let next = null
      let gaps = 0
      const until = performance.now() + seconds * 1000
      while (performance.now() < until) {
        const { value: frame, done } = await reader.read()
        if (done) break
        rate = frame.sampleRate
        const at = Math.round((frame.timestamp / 1e6) * rate)
        if (next !== null && at !== next) gaps += at - next
        next = at + frame.numberOfFrames
        const x = new Float32Array(frame.numberOfFrames)
        frame.copyTo(x, { planeIndex: 0, format: 'f32-planar' })
        chunks.push(x)
        frame.close()
      }
      const settings = track.getSettings()
      stream.getTracks().forEach((t) => t.stop())
      const n = chunks.reduce((a, c) => a + c.length, 0)
      const all = new Float32Array(n)
      let o = 0
      for (const c of chunks) {
        all.set(c, o)
        o += c.length
      }
      const bytes = new Uint8Array(all.buffer)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { data: btoa(bin), settings, rate, gaps }
    }, { constraints, seconds })
    if (out.rate !== 48000) console.warn(`the capture runs at ${out.rate} Hz`)
    return { pcm: base64ToF32(out.data), settings: out.settings, gaps: out.gaps }
  } finally {
    await browser.close()
  }
}

/** Opus as a call sends it, both ways, in one page (WebCodecs: the browser's own libopus). */
export async function opusCodec() {
  const { browser, page } = await open()
  return {
    /** Encodes and decodes `x` (48 kHz mono), 20 ms at a time. */
    async roundTrip(x, config) {
      const out = await page.evaluate(async ({ data, config }) => {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const x = new Float32Array(bytes.buffer)
        const packets = []
        const encoder = new AudioEncoder({
          output: (c) => {
            const b = new Uint8Array(c.byteLength)
            c.copyTo(b)
            packets.push({ timestamp: c.timestamp, duration: c.duration, data: b })
          },
          error: (e) => { throw e },
        })
        encoder.configure(config)
        const hop = 960
        for (let k = 0; k + hop <= x.length; k += hop) {
          encoder.encode(new AudioData({ format: 'f32', sampleRate: 48000, numberOfChannels: 1, numberOfFrames: hop, timestamp: Math.round((k / 48000) * 1e6), data: x.slice(k, k + hop) }))
        }
        await encoder.flush()
        encoder.close()
        const y = new Float32Array(x.length)
        const decoder = new AudioDecoder({
          output: (d) => {
            const frame = new Float32Array(d.numberOfFrames)
            d.copyTo(frame, { planeIndex: 0, format: 'f32-planar' })
            const at = Math.round((d.timestamp / 1e6) * 48000)
            y.set(frame.subarray(0, Math.max(0, Math.min(frame.length, y.length - at))), at)
            d.close()
          },
          error: (e) => { throw e },
        })
        decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })
        let bytesSent = 0
        for (const p of packets) {
          bytesSent += p.data.length
          decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.timestamp, duration: p.duration, data: p.data }))
        }
        await decoder.flush()
        decoder.close()
        const ob = new Uint8Array(y.buffer)
        let s = ''
        for (let i = 0; i < ob.length; i += 0x8000) s += String.fromCharCode(...ob.subarray(i, i + 0x8000))
        return { data: btoa(s), packets: packets.length, kbps: (bytesSent * 8) / (x.length / 48000) / 1000 }
      }, { data: f32ToBase64(x), config })
      return { pcm: base64ToF32(out.data), packets: out.packets, kbps: out.kbps }
    },
    close: () => browser.close(),
  }
}
