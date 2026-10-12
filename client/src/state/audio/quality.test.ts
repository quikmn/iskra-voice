// The voice chain measured on real audio (the e2e speech fixture, clean, with fan and keyboard noise, quiet), through
// the same code the worklets run. Thresholds: clean speech comes out near-transparent, noise goes, nothing is dropped,
// chattered or clipped. scripts/audio-quality.mjs prints the full table (docs/voice-processing.md).
import { describe, expect, it } from 'vitest'
import { DF_STRENGTH_DB } from './strength'
import { VAD_DEFAULTS } from './vadGate'
import {
  clipped, findLag, gain, goldenInputs, keyboard, lagSpread, loadEngines, measure, mix, phrases, pinkNoise, RATE, readWav, rmsDb, runChain,
  upsample, voicedFrames,
} from './quality'

// Node's fs, without pulling Node's types into the app's type check.
const fs = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync(path: URL): Uint8Array }
const file = (path: string) => {
  const b = readFileSync(new URL(path, import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

const wasm = file('../../../vendor/deepfilternet/deepfilter.wasm')
const model = file('../../../vendor/deepfilternet/DeepFilterNet3_onnx.tar.gz.bin')
const engines = loadEngines(wasm, model, file('../../../vendor/silero-vad/silero_vad_16k_op15.onnx'))
const fixture = readWav(file('../../../e2e/fixtures/speech.wav'))
const clean = upsample(fixture.pcm, RATE / fixture.rate)
const noisy = mix(clean, pinkNoise(clean.length, -42), keyboard(clean.length, RATE, -16))
const normal = DF_STRENGTH_DB.normal

describe('voice chain quality (offline, real audio)', { timeout: 60000 }, () => {
  it('AI noise removal leaves clean speech alone', () => {
    const r = measure(clean, runChain(clean, engines, { deepFilter: normal, gate: false, leveler: false }), 'sent')
    expect(r.sdr).toBeGreaterThan(18)
    expect(r.speechGainDb).toBeGreaterThan(-1.5) // was -9.5 dB with libDF's own thresholds
    expect(r.speechDipDb).toBeGreaterThan(-3)
    expect(r.gainRms).toBeLessThan(0.6)
    expect(r.timingMs).toBe(0)
    expect(r.clipped).toBe(0)
  })

  it('AI noise removal takes out fan and keyboard noise without hurting the voice', () => {
    const before = measure(clean, runChain(noisy, engines, { deepFilter: 0, gate: false, leveler: false }), 'sent', noisy)
    const r = measure(clean, runChain(noisy, engines, { deepFilter: normal, gate: false, leveler: false }), 'sent', noisy)
    expect(r.noiseReductionDb).toBeGreaterThan(18)
    expect(r.sdr).toBeGreaterThan(before.sdr)
    expect(r.lsd).toBeLessThan(before.lsd)
    expect(r.speechGainDb).toBeGreaterThan(-1.5)
  })

  it('the gate passes speech untouched: nothing dropped, no chatter', () => {
    const r = measure(clean, runChain(clean, engines, { deepFilter: null, gate: true, leveler: false }), 'sent')
    expect(r.sdr).toBeGreaterThan(50)
    expect(r.timingMs).toBe(0)
    expect(r.transitions).toBe(1) // opens once and stays open through the pauses
    expect(Math.abs(r.latencyMs - VAD_DEFAULTS.preRollMs)).toBeLessThan(5)
  })

  it('the gate opens in time for every phrase, and its pre-roll covers the start', () => {
    const { signal, onsets } = phrases(clean)
    expect(onsets.length).toBeGreaterThan(10)
    const run = runChain(signal, engines, { deepFilter: normal, gate: true, leveler: false })
    let transitions = 0
    for (let k = 1; k < run.open.length; k++) if (run.open[k] !== run.open[k - 1]) transitions++
    expect(transitions).toBe(2 * onsets.length) // opens and closes once per phrase
    const dfDelay = findLag(signal, runChain(signal, engines, { deepFilter: normal, gate: false, leveler: false }).sent).lag
    for (const on of onsets) {
      let k = Math.floor(on / 128)
      while (k < run.open.length && !run.open[k]) k++
      const lateMs = ((k * 128 - on - dfDelay) / RATE) * 1000
      expect(lateMs).toBeLessThan(VAD_DEFAULTS.preRollMs - 30)
    }
  })

  it('leveling evens out a quiet talker smoothly, without clipping', () => {
    const quiet = gain(clean, -20)
    const r = measure(quiet, runChain(quiet, engines, { deepFilter: null, gate: false, leveler: true }), 'heard')
    expect(r.speechGainDb).toBeGreaterThan(5)
    expect(r.gainMax).toBeLessThan(2.5)
    expect(r.clipped).toBe(0)
    const loud = gain(clean, 4) // peaks at about -1 dBFS
    const l = runChain(loud, engines, { deepFilter: null, gate: false, leveler: true })
    expect(l.heard.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThanOrEqual(0.891)
  })

  it('input volume above 100% never clips what is sent', () => {
    const r = runChain(clean, engines, { deepFilter: null, gate: false, leveler: false, inputVolume: 2 })
    expect(clipped(r.sent)).toBe(0)
    expect(r.sent.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThanOrEqual(0.971)
  })

  it('the full chain: transparent enough, nothing dropped or clipped', () => {
    const r = measure(clean, runChain(clean, engines, { deepFilter: normal, gate: true, leveler: true }), 'heard')
    expect(r.lsd).toBeLessThan(7)
    expect(r.gainRms).toBeLessThan(0.6)
    expect(r.timingMs).toBe(0)
    expect(r.transitions).toBe(1)
    expect(r.clipped).toBe(0)
    const n = measure(clean, runChain(noisy, engines, { deepFilter: normal, gate: true, leveler: true }), 'heard', noisy)
    expect(n.noiseReductionDb).toBeGreaterThan(12)
    expect(n.timingMs).toBe(0)
  })
})

describe("DeepFilterNet matches DeepFilterNet's own command line tool (golden files)", { timeout: 60000 }, () => {
  const inputs = goldenInputs(clean)
  const reference = (name: string) => readWav(file(`../../../vendor/deepfilternet/golden/${name}.deep-filter-0.5.6.wav`)).pcm
  const ours = (x: Float32Array, legacy = false) => {
    const process = engines.deepFilter(100, legacy)
    const y = new Float32Array(x.length)
    for (let i = 0; i + 480 <= x.length; i += 480) y.set(process(x.subarray(i, i + 480)), i)
    return y
  }
  /** Output against output, sample by sample (both have the same 30 ms delay), from the first second on. */
  const snr = (ref: Float32Array, y: Float32Array) => {
    let s = 0
    let e = 0
    for (let i = RATE; i < ref.length - 480; i++) {
      s += ref[i] * ref[i]
      e += (ref[i] - y[i]) ** 2
    }
    return 10 * Math.log10(s / e)
  }
  const sdr = (y: Float32Array) => measure(inputs.clean, { sent: y, heard: y, open: new Uint8Array(1) }, 'sent').sdr

  it('on clean speech: the same output, to within 16-bit rounding and float order', () => {
    expect(snr(reference('clean'), ours(inputs.clean))).toBeGreaterThan(35)
    // libDF's WebAssembly defaults (how it ran before) are far off.
    expect(snr(reference('clean'), ours(inputs.clean, true))).toBeLessThan(25)
  })

  it('on noisy speech: the same quality against the clean speech', () => {
    const ref = sdr(reference('noisy'))
    // 19.3 vs 19.8 dB: the recurrent state amplifies float-order differences between tract versions on noise.
    expect(Math.abs(sdr(ours(inputs.noisy)) - ref)).toBeLessThan(1)
    expect(sdr(ours(inputs.noisy, true))).toBeLessThan(ref - 6) // 5.5 dB as it was
  })
})

describe('DeepFilterNet worklet in a simulated audio thread', { timeout: 120000 }, () => {
  interface Port { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void }
  interface Processor { port: Port; process(i: Float32Array[][], o: Float32Array[][]): boolean }
  let Ctor: (new () => Processor) | null = null
  const said: unknown[] = []

  async function worklet(): Promise<Processor> {
    if (!Ctor) {
      const g = globalThis as Record<string, unknown>
      g.sampleRate = RATE
      g.AudioWorkletProcessor = class {
        port: Port = { onmessage: null, postMessage: (m: unknown) => said.push(m) }
      }
      g.registerProcessor = (_: string, c: new () => Processor) => (Ctor = c)
      await import('./deepfilter.worklet')
    }
    if (!Ctor) throw new Error('not registered')
    said.length = 0
    return new Ctor()
  }

  /** `seconds` of the fixture over and over, in 128-sample render quanta. */
  function play(node: Processor, seconds: number): { input: Float32Array; output: Float32Array } {
    const n = Math.floor((seconds * RATE) / 128) * 128
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = clean[i % clean.length]
    const output = new Float32Array(n)
    const out = [[new Float32Array(128)]]
    for (let k = 0; k < n; k += 128) {
      node.process([[input.subarray(k, k + 128)]], out)
      output.set(out[0][0], k)
    }
    return { input, output }
  }

  it('keeps every sample in order for minutes: no drift, drops or repeats at the 128/480 boundaries', async () => {
    const node = await worklet()
    node.port.onmessage!({ data: { module: new WebAssembly.Module(wasm), model, strength: 0 } })
    expect(said[0]).toMatchObject({ type: 'ready' })
    const latency = (said[0] as { latency: number }).latency
    // At 0 dB DeepFilterNet passes its input through, so this checks the framing and the worklet glue exactly.
    const { input, output } = play(node, 180)
    let mismatches = 0
    for (let i = latency; i < output.length; i++) if (output[i] !== input[i - latency]) mismatches++
    expect(mismatches).toBe(0)
  })

  it('at the default strength holds the same delay throughout and never clips', async () => {
    const node = await worklet()
    node.port.onmessage!({ data: { module: new WebAssembly.Module(wasm), model, strength: normal } })
    expect(said[0]).toMatchObject({ type: 'ready' })
    const { input, output } = play(node, 30)
    const spread = lagSpread(input, output, voicedFrames(input, -45))
    expect(spread.windows).toBeGreaterThan(50)
    expect(spread.max - spread.min).toBe(0)
    expect(clipped(output)).toBe(0)
    expect(Math.abs(rmsDb(output) - rmsDb(input))).toBeLessThan(3)
    // The strength can change while it runs.
    node.port.onmessage!({ data: { strength: DF_STRENGTH_DB.max } })
    expect(clipped(play(node, 2).output)).toBe(0)
  })
})
