import { describe, expect, it } from 'vitest'
import { Downsampler } from './resample'
import { parseOnnxWeights, SILERO_FRAME, SILERO_RATE, SileroVad } from './silero'

// Node's fs, without pulling Node's types into the app's type check.
const fs = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync(path: URL): Uint8Array }

const file = (path: string) => {
  const b = readFileSync(new URL(path, import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/** 16-bit mono PCM from a WAV file. */
function wav(path: string): { rate: number; pcm: Float32Array } {
  const view = new DataView(file(path))
  let o = 12
  let rate = 0
  while (o + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
    const size = view.getUint32(o + 4, true)
    if (id === 'fmt ') rate = view.getUint32(o + 12, true)
    if (id === 'data') {
      const pcm = new Float32Array(size / 2)
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(o + 8 + i * 2, true) / 32768
      return { rate, pcm }
    }
    o += 8 + size
  }
  throw new Error('no data')
}

const weights = parseOnnxWeights(file('../../../vendor/silero-vad/silero_vad_16k_op15.onnx'))
// The fixture: about a second of room tone, then someone talking.
const speech = wav('../../../e2e/fixtures/speech.wav')

function probabilities(pcm: Float32Array): number[] {
  const vad = new SileroVad(weights)
  const out: number[] = []
  for (let f = 0; (f + 1) * SILERO_FRAME <= pcm.length; f++) out.push(vad.process(pcm.subarray(f * SILERO_FRAME, (f + 1) * SILERO_FRAME)))
  return out
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

describe('Silero VAD', () => {
  it('reads the bundled model', () => {
    expect(Object.keys(weights).sort()).toEqual(['bhh', 'bih', 'c1b', 'c1w', 'c2b', 'c2w', 'c3b', 'c3w', 'c4b', 'c4w', 'fb', 'fw', 'stft', 'whh', 'wih'])
    expect(weights.stft.shape).toEqual([258, 1, 256])
  })

  it('rejects a model that is not Silero', () => {
    expect(() => new SileroVad({})).toThrow(/missing/)
  })

  it('scores speech high and silence low', () => {
    expect(speech.rate).toBe(SILERO_RATE)
    const p = probabilities(speech.pcm)
    const silence = p.slice(0, 28) // the first 0.9 s
    const talking = p.slice(40, 140)
    expect(Math.max(...silence)).toBeLessThan(0.2)
    expect(mean(talking)).toBeGreaterThan(0.8)
    expect(talking.filter((x) => x > 0.5).length).toBeGreaterThan(90)
  })

  it('stays quiet on pure silence and starts over after reset', () => {
    const vad = new SileroVad(weights)
    const zero = new Float32Array(SILERO_FRAME)
    for (let i = 0; i < 20; i++) expect(vad.process(zero)).toBeLessThan(0.1)
    vad.reset()
    expect(vad.process(zero)).toBeLessThan(0.1)
  })

  it('hears the same from a 48 kHz mic through the downsampler', () => {
    // Upsample the fixture to 48 kHz (linear: fine for a test), then back down the way the worklet does.
    const up = new Float32Array(speech.pcm.length * 3)
    for (let i = 0; i < up.length; i++) {
      const p = i / 3
      const a = Math.floor(p)
      up[i] = speech.pcm[a] + ((speech.pcm[a + 1] ?? 0) - speech.pcm[a]) * (p - a)
    }
    const vad = new SileroVad(weights)
    const p: number[] = []
    const down = new Downsampler(48000, SILERO_RATE, SILERO_FRAME, (frame) => p.push(vad.process(frame)))
    for (let i = 0; i < up.length; i += 128) down.push(up.subarray(i, i + 128))
    expect(Math.abs(p.length - Math.floor(speech.pcm.length / SILERO_FRAME))).toBeLessThanOrEqual(1)
    expect(Math.max(...p.slice(0, 28))).toBeLessThan(0.2)
    expect(mean(p.slice(40, 140))).toBeGreaterThan(0.8)
  })
})
