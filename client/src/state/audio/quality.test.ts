// The voice chain measured on real audio (the e2e speech fixture, clean, with fan and keyboard noise, quiet), through
// the same code the worklets run. Thresholds: clean speech comes out near-transparent, noise goes, nothing is dropped,
// chattered or clipped. scripts/audio-quality.mjs prints the full table (docs/voice-processing.md).
import { describe, expect, it } from 'vitest'
import { df_process_frame } from '../../../vendor/deepfilternet/deepfilter.js'
import { createDeepFilter, DF_STRENGTH_DB, warmUp } from './strength'
import { createSlots, queueDelay, serveSlots, servePort } from './dfQueue'
import { Framer } from './framer'
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

  /** How late the gate opens after each onset (ms), with DeepFilterNet's own delay taken out. */
  function lateness(signal: Float32Array, onsets: number[], input: Float32Array) {
    const run = runChain(input, engines, { deepFilter: normal, gate: true, leveler: false })
    const dfDelay = findLag(signal, runChain(input, engines, { deepFilter: normal, gate: false, leveler: false }).sent).lag
    const late = onsets.map((on) => {
      let k = Math.floor(on / 128)
      while (k < run.open.length && !run.open[k]) k++
      return ((k * 128 - on - dfDelay) / RATE) * 1000
    })
    let transitions = 0
    for (let k = 1; k < run.open.length; k++) if (run.open[k] !== run.open[k - 1]) transitions++
    return { late, transitions }
  }

  it.each(['clean', 'noisy'])('the gate opens in time for every phrase (%s): the pre-roll covers the voiced start', (which) => {
    const voiced = phrases(clean, -30) // where the word gets loud
    const faint = phrases(clean, -45) // its faintest lead-in, 20-30 dB down
    const input = which === 'clean' ? voiced.signal : mix(voiced.signal, pinkNoise(voiced.signal.length, -42), keyboard(voiced.signal.length, RATE, -16))
    expect(voiced.onsets.length).toBeGreaterThan(10)
    const v = lateness(voiced.signal, voiced.onsets, input)
    expect(v.transitions).toBe(2 * voiced.onsets.length) // opens and closes once per phrase
    // Nothing voiced is ever lost.
    for (const late of v.late) expect(late).toBeLessThan(VAD_DEFAULTS.preRollMs)
    // A faint lead-in is softened by at most 50 ms, and usually not at all or barely.
    const loss = lateness(faint.signal, faint.onsets, input).late.map((late) => Math.max(0, late - VAD_DEFAULTS.preRollMs)).sort((x, y) => x - y)
    expect(loss[loss.length - 1]).toBeLessThanOrEqual(50)
    expect(loss[Math.floor(loss.length / 2)]).toBeLessThanOrEqual(30)
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

describe('DeepFilterNet off the audio thread: worklet and worker, simulated', { timeout: 240000 }, () => {
  interface Port { onmessage: ((e: { data: unknown }) => void) | null; postMessage(m: unknown): void }
  interface Processor { port: Port; process(i: Float32Array[][], o: Float32Array[][]): boolean }
  let Ctor: (new (options: { processorOptions: { delay: number } }) => Processor) | null = null
  const said: { type: string; latency?: number }[] = []
  const DELAY = queueDelay(512) // render calls in bursts of four (10 ms device buffers)
  const tick = () => new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(f: () => void): void }).setImmediate(resolve))

  async function worklet(strength: number): Promise<Processor> {
    if (!Ctor) {
      const g = globalThis as Record<string, unknown>
      g.sampleRate = RATE
      g.AudioWorkletProcessor = class {
        port: Port = { onmessage: null, postMessage: (m: unknown) => said.push(m as { type: string }) }
      }
      g.registerProcessor = (_: string, c: typeof Ctor) => (Ctor = c)
      await import('./deepfilter.worklet')
    }
    if (!Ctor) throw new Error('not registered')
    said.length = 0
    const node = new Ctor({ processorOptions: { delay: DELAY } })
    node.port.onmessage!({ data: { strength } })
    return node
  }

  /** DeepFilterNet3 the way the worker runs it (fresh state, warmed up), counting the frames it processed. */
  function engine(strength: number) {
    const state = createDeepFilter(new Uint8Array(model), strength)
    warmUp(state, df_process_frame)
    const counter = { frames: 0 }
    return { counter, process: (frame: Float32Array) => { frame.set(df_process_frame(state, frame)); counter.frames++ }, ref: (frame: Float32Array) => df_process_frame(state, frame) }
  }

  /** Links the worklet to "the worker" (this thread) over a port or shared slots, as the page does. */
  function link(node: Processor, process: (frame: Float32Array) => void, shared: boolean): () => void {
    if (shared) {
      const slots = createSlots()
      const stop = serveSlots(slots, process)
      node.port.onmessage!({ data: { slots } })
      return stop
    }
    const channel = new MessageChannel()
    const stop = servePort(channel.port2, process)
    node.port.onmessage!({ data: { port: channel.port1 } })
    return stop
  }

  /** Plays `input` in 128-sample render calls, four back to back and then a pause in which the worker catches up. */
  async function play(node: Processor, input: Float32Array, counter: { frames: number }): Promise<Float32Array> {
    const output = new Float32Array(input.length)
    const out = [[new Float32Array(128)]]
    for (let k = 0; k < input.length; k += 128) {
      node.process([[input.subarray(k, k + 128)]], out)
      output.set(out[0][0], k)
      if ((k / 128) % 4 === 3) {
        for (let i = 0; i < 50 && counter.frames < Math.floor((k + 128) / 480); i++) await tick()
        await tick()
        await tick()
      }
    }
    return output
  }

  const loop = (seconds: number) => {
    const n = Math.floor((seconds * RATE) / 128) * 128
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = clean[i % clean.length]
    return x
  }

  it.each([['a port', false], ['shared slots', true]] as const)('keeps every sample in order for minutes (%s): no drift, drops or repeats', async (_, shared) => {
    const node = await worklet(0)
    const dfn = engine(0) // at 0 dB DeepFilterNet passes its input through: this checks the queue and the glue exactly
    const stop = link(node, dfn.process, shared)
    expect(said[0]).toMatchObject({ type: 'ready', latency: DELAY })
    const input = loop(shared ? 60 : 180)
    const output = await play(node, input, dfn.counter)
    stop()
    let mismatches = 0
    for (let i = 0; i < output.length; i++) if (output[i] !== (i < DELAY ? 0 : input[i - DELAY])) mismatches++
    expect(mismatches).toBe(0)
    expect(said.filter((m) => m.type === 'late' && (m as { overruns?: number }).overruns)).toEqual([])
  })

  it.each([['a port', false], ['shared slots', true]] as const)('speech.wav end to end (%s): exactly what the in-thread framer gave, a fixed time later', async (_, shared) => {
    const input = loop(30) // the fixture, over and over
    // The in-thread path as it was: the framer running DeepFilterNet inside the render call.
    const inThread = new Framer(480, RATE, engine(normal).ref)
    const reference = new Float32Array(input.length)
    const block = new Float32Array(128)
    for (let k = 0; k < input.length; k += 128) {
      inThread.push(input.subarray(k, k + 128), block)
      reference.set(block, k)
    }
    const node = await worklet(normal)
    const dfn = engine(normal)
    const stop = link(node, dfn.process, shared)
    const output = await play(node, input, dfn.counter)
    stop()
    const shift = DELAY - inThread.latency
    let mismatches = 0
    for (let i = 0; i < output.length; i++) if (output[i] !== (i < shift ? 0 : reference[i - shift])) mismatches++
    expect(mismatches).toBe(0)
    expect(said.filter((m) => m.type === 'late' && (m as { overruns?: number }).overruns)).toEqual([])
    expect(clipped(output)).toBe(0)
    const spread = lagSpread(input, output, voicedFrames(input, -45))
    expect(spread.windows).toBeGreaterThan(50)
    expect(spread.max - spread.min).toBe(0)
    expect(Math.abs(rmsDb(output) - rmsDb(input))).toBeLessThan(3)
  })

  it('the strength can change while it runs', async () => {
    const node = await worklet(normal)
    const dfn = engine(normal)
    const stop = link(node, dfn.process, false)
    await play(node, loop(2), dfn.counter)
    node.port.onmessage!({ data: { strength: DF_STRENGTH_DB.max } })
    expect(clipped(await play(node, loop(2), dfn.counter))).toBe(0)
    stop()
  })
})
