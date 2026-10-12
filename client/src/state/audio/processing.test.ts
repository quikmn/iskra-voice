import { describe, expect, it } from 'vitest'
import { fallbackReason, pickEngine, SlowWatch, SLOW_WINDOWS, type EngineCaps, type EngineHealth } from './engines'
import { COMPRESSOR, compressorGainDb, Leveler, Limiter, LEVEL_MAX_DB, LEVEL_RATE_DB_PER_S, LEVEL_TARGET_DB, LIMIT } from './leveler'
import { VadGate } from './vadGate'

const RATE = 48000
const BLOCK = 128
const BLOCK_MS = (BLOCK / RATE) * 1000

describe('noise suppression engine', () => {
  const all: EngineCaps = { worklet: true, simd: true }
  const fine: EngineHealth = { aiBroken: false, aiSlow: false, rnnoiseBroken: false }

  it('runs what you chose when the device can', () => {
    expect(pickEngine('ai', all, fine)).toBe('ai')
    expect(pickEngine('strong', all, fine)).toBe('rnnoise')
    expect(pickEngine('standard', all, fine)).toBe('browser')
    expect(pickEngine('off', all, fine)).toBe('off')
    expect(fallbackReason('ai', all, fine)).toBeNull()
  })

  it('falls back from AI to RNNoise without SIMD, when too slow or when it failed', () => {
    expect(pickEngine('ai', { worklet: true, simd: false }, fine)).toBe('rnnoise')
    expect(fallbackReason('ai', { worklet: true, simd: false }, fine)).toBe('unsupported')
    expect(pickEngine('ai', all, { ...fine, aiSlow: true })).toBe('rnnoise')
    expect(fallbackReason('ai', all, { ...fine, aiSlow: true })).toBe('slow')
    expect(pickEngine('ai', all, { ...fine, aiBroken: true })).toBe('rnnoise')
    expect(fallbackReason('ai', all, { ...fine, aiBroken: true })).toBe('failed')
  })

  it("falls back to the browser's when no WebAssembly engine can run", () => {
    expect(pickEngine('ai', { worklet: false, simd: true }, fine)).toBe('browser')
    expect(pickEngine('ai', all, { aiBroken: true, aiSlow: false, rnnoiseBroken: true })).toBe('browser')
    expect(pickEngine('strong', all, { ...fine, rnnoiseBroken: true })).toBe('browser')
    expect(fallbackReason('strong', { worklet: false, simd: false }, fine)).toBe('unsupported')
    // Off and standard never need anything.
    expect(pickEngine('off', { worklet: false, simd: false }, fine)).toBe('off')
  })

  it('only gives up after several slow seconds in a row', () => {
    const watch = new SlowWatch()
    for (let i = 0; i < SLOW_WINDOWS - 1; i++) expect(watch.report(0.9)).toBe(false)
    expect(watch.report(0.2)).toBe(false) // a hiccup, not a slow device
    for (let i = 0; i < SLOW_WINDOWS - 1; i++) expect(watch.report(0.9)).toBe(false)
    expect(watch.report(0.9)).toBe(true)
  })
})

describe('voice activity gate (Silero)', () => {
  /** Blocks numbered 1, 2, 3…: each block is filled with its number, so the output shows which one was sent. */
  function run(gate: VadGate, probs: number[]): number[] {
    const out = new Float32Array(BLOCK)
    const sent: number[] = []
    probs.forEach((p, i) => {
      gate.setProbability(p)
      gate.process(new Float32Array(BLOCK).fill(i + 1), out)
      sent.push(out[BLOCK - 1])
    })
    return sent
  }
  const ms = (n: number) => Math.round(n / BLOCK_MS)

  it('sends nothing while you are quiet', () => {
    const gate = new VadGate(RATE)
    expect(run(gate, Array(ms(500)).fill(0.05)).every((x) => x === 0)).toBe(true)
    expect(gate.open).toBe(false)
  })

  it('opens with the pre-roll, so the start of a word is sent', () => {
    const gate = new VadGate(RATE)
    const quiet = ms(500)
    const sent = run(gate, [...Array(quiet).fill(0.05), ...Array(ms(100)).fill(0.95)])
    expect(gate.open).toBe(true)
    // The first block sent is from about 250 ms before speech was detected.
    const first = sent.findIndex((x) => x !== 0)
    expect(first).toBe(quiet)
    const preRollBlocks = ms(gate.params.preRollMs)
    expect(sent[first]).toBeGreaterThan(0)
    expect(Math.round(sent[first + 5])).toBe(quiet + 5 + 1 - preRollBlocks)
    expect(gate.latencyMs).toBeCloseTo(gate.params.preRollMs, -1)
  })

  it('stays open through short pauses (hangover) and closes after a longer one', () => {
    const gate = new VadGate(RATE)
    run(gate, Array(ms(200)).fill(0.9))
    run(gate, Array(ms(300)).fill(0.1)) // a pause between sentences
    expect(gate.open).toBe(true)
    run(gate, Array(ms(100)).fill(0.9))
    run(gate, Array(ms(gate.params.hangoverMs) - 2).fill(0.1))
    expect(gate.open).toBe(true)
    const tail = run(gate, Array(ms(200)).fill(0.1))
    expect(gate.open).toBe(false)
    expect(tail[tail.length - 1]).toBe(0) // faded out
  })

  it('in between the thresholds keeps the current state (no flapping)', () => {
    const gate = new VadGate(RATE)
    run(gate, Array(ms(100)).fill(0.4))
    expect(gate.open).toBe(false)
    run(gate, Array(ms(50)).fill(0.9))
    run(gate, Array(ms(2000)).fill(0.4))
    expect(gate.open).toBe(true)
  })

  it('never drops or repeats audio: stays one pre-roll behind while open, through pauses', () => {
    const gate = new VadGate(RATE)
    const probs = [...Array(ms(100)).fill(0.9)]
    for (let i = 0; i < 3; i++) probs.push(...Array(ms(400)).fill(0.9), ...Array(ms(300)).fill(0.1))
    const sent = run(gate, probs)
    expect(gate.open).toBe(true)
    const delay = ms(gate.params.preRollMs)
    // After the fade-in, every block is the one exactly `delay` blocks before it: in order, none skipped.
    const first = sent.findIndex((x) => x !== 0) + 5
    const wrong = sent.map((x, i) => [i, Math.round(x) - (i + 1 - delay)]).filter(([i, d]) => i >= first && d !== 0)
    expect(wrong).toEqual([])
    expect(gate.latencyMs).toBeCloseTo(gate.params.preRollMs, -1)
  })

  it('reopening while it fades out carries on without a jump', () => {
    const gate = new VadGate(RATE)
    run(gate, Array(ms(200)).fill(0.9))
    run(gate, Array(ms(gate.params.hangoverMs)).fill(0.1)) // closes, starts fading
    const before = gate.latencyMs
    const sent = run(gate, [0.9, 0.9, 0.9])
    expect(gate.latencyMs).toBe(before)
    expect(Math.round(sent[2]) - Math.round(sent[1])).toBe(1)
  })

  it('starts over with the pre-roll once fully closed', () => {
    const gate = new VadGate(RATE)
    run(gate, Array(ms(200)).fill(0.9))
    run(gate, Array(ms(gate.params.hangoverMs + 100)).fill(0.1))
    expect(gate.open).toBe(false)
    expect(gate.latencyMs).toBe(0)
    run(gate, [0.9])
    expect(gate.latencyMs).toBeCloseTo(gate.params.preRollMs, -1)
  })

  it('never delays or gates push-to-talk, but still knows when you speak', () => {
    const gate = new VadGate(RATE)
    gate.params = { ...gate.params, gating: false }
    const sent = run(gate, [0.01, 0.01, 0.9, 0.9])
    expect(sent).toEqual([1, 2, 3, 4])
    expect(gate.open).toBe(true)
    expect(gate.latencyMs).toBe(0)
  })
})

describe('incoming loudness leveling', () => {
  const tone = (amplitude: number, n = BLOCK, phase = 0) => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * (phase + i)) / RATE)
    return out
  }
  const feed = (leveler: Leveler, amplitude: number, seconds: number) => {
    const out = new Float32Array(BLOCK)
    const blocks = Math.round((seconds * RATE) / BLOCK)
    for (let b = 0; b < blocks; b++) leveler.process(tone(amplitude, BLOCK, b * BLOCK), out)
    return out
  }
  const rmsDb = (x: Float32Array) => 10 * Math.log10(x.reduce((a, v) => a + v * v, 0) / x.length)

  it('compresses above the threshold with a soft knee', () => {
    const { threshold, ratio, knee } = COMPRESSOR
    expect(compressorGainDb(threshold - knee)).toBe(0)
    expect(compressorGainDb(threshold + 10)).toBeCloseTo(-10 * (1 - 1 / ratio))
    expect(compressorGainDb(threshold)).toBeLessThan(0) // in the knee
    expect(compressorGainDb(threshold)).toBeGreaterThan(compressorGainDb(threshold + 3))
  })

  it('the limiter catches a sudden peak smoothly: no clipping, no gain steps', () => {
    const limiter = new Limiter(RATE)
    const n = RATE / 2
    const out = new Float32Array(n)
    const gains: number[] = []
    for (let i = 0; i < n; i++) {
      // Quiet tone, then a burst at +6 dBFS for 20 ms.
      const amp = i > RATE / 10 && i < RATE / 10 + RATE / 50 ? 2 : 0.1
      out[i] = limiter.step(amp * Math.sin((2 * Math.PI * 220 * i) / RATE))
      gains.push(limiter.gain)
    }
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(LIMIT)
    let steepest = 0
    for (let i = 1; i < gains.length; i++) steepest = Math.max(steepest, Math.abs(gains[i] - gains[i - 1]))
    // From 1 to about 0.45 over the 1.5 ms look-ahead at the least: never a jump within a sample.
    expect(steepest).toBeLessThan(0.02)
    // The tone before the burst is untouched (only delayed).
    expect(out[limiter.lookahead + 100]).toBeCloseTo(0.1 * Math.sin((2 * Math.PI * 220 * 100) / RATE), 6)
  })

  it('moves its gain smoothly: no steps, only as fast as its attack allows', () => {
    const leveler = new Leveler(RATE)
    let prev = 1
    let steepest = 0
    const out = new Float32Array(BLOCK)
    for (let b = 0; b < (3 * RATE) / BLOCK; b++) {
      // Syllables: 150 ms loud, 100 ms quiet.
      const amp = b % 94 < 56 ? 0.5 : 0.02
      leveler.process(tone(amp, BLOCK, b * BLOCK), out)
      steepest = Math.max(steepest, Math.abs(leveler.compressorGain - prev))
      prev = leveler.compressorGain
    }
    // At most about 1 dB per 128-sample block (10 ms attack on a 14 dB jump), and only gradually after that.
    expect(steepest).toBeLessThan(0.15)
  })

  it('brings a quiet talker up towards the target, no faster than the rate limit', () => {
    const leveler = new Leveler(RATE)
    feed(leveler, 0.02, 1) // about -37 dBFS
    expect(leveler.gainDb).toBeGreaterThan(0)
    expect(leveler.gainDb).toBeLessThanOrEqual(LEVEL_RATE_DB_PER_S * 1 + 0.01)
    const out = feed(leveler, 0.02, 15)
    expect(leveler.gainDb).toBeCloseTo(LEVEL_MAX_DB, 0) // capped
    expect(rmsDb(out)).toBeGreaterThan(-37 + LEVEL_MAX_DB - 1)
  })

  it('turns a loud talker down and keeps peaks below clipping', () => {
    const leveler = new Leveler(RATE)
    const out = feed(leveler, 1, 10)
    expect(leveler.gainDb).toBeLessThan(-5)
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(0.9)
    expect(rmsDb(out)).toBeLessThan(-6)
  })

  it('leaves a talker at the target alone and never boosts silence', () => {
    const leveler = new Leveler(RATE)
    const amplitude = Math.pow(10, LEVEL_TARGET_DB / 20) * Math.SQRT2
    feed(leveler, amplitude, 5)
    expect(Math.abs(leveler.gainDb)).toBeLessThan(1)
    const quiet = new Leveler(RATE)
    feed(quiet, 0.0005, 5) // background hiss in a pause
    expect(quiet.gainDb).toBe(0)
  })
})

describe('framer (128-sample blocks to 480-sample frames)', () => {
  it('plays every frame back at a fixed delay without ever running dry', async () => {
    const { Framer } = await import('./framer')
    let clock = 0
    const framer = new Framer(480, RATE, (frame) => {
      clock += 1 // 1 ms per 10 ms frame
      return frame.slice()
    }, BLOCK, () => clock)
    const input: number[] = []
    const output: number[] = []
    const out = new Float32Array(BLOCK)
    for (let b = 0; b < 200; b++) {
      const block = new Float32Array(BLOCK).map((_, i) => b * BLOCK + i + 1)
      input.push(...block)
      framer.push(block, out)
      output.push(...out)
    }
    const delay = framer.latency
    expect(output.slice(0, delay).every((x) => x === 0)).toBe(true)
    expect(output.slice(delay)).toEqual(input.slice(0, input.length - delay))
    expect(framer.takeRtf()).toBeCloseTo(0.1)
    expect(framer.takeRtf()).toBeNull()
  })
})
