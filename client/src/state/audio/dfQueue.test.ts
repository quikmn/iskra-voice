// The queue between the audio worklet and the DeepFilterNet worker (dfQueue.ts), with a stand-in for the network:
// fixed delay, nothing dropped or repeated, and a smooth bridge over a worker that falls behind.
import { describe, expect, it } from 'vitest'
import { BridgeWatch, MAX_BRIDGED, SLOW_WINDOWS } from './engines'
import { BLOCK, FRAME, FrameQueue, MODEL_DELAY, PortLink, queueDelay, SLOTS, type FrameLink } from './dfQueue'

const DELAY = queueDelay(512)

/** A worker in the test's hands: frames wait until `deliver()`; `stalled` holds them back. */
class TestLink implements FrameLink {
  readonly waiting: { index: number; frame: Float32Array }[] = []
  stalled = false
  private readonly take: (index: number, frame: Float32Array) => void
  private readonly process: (f: Float32Array) => void
  private readonly slots: number
  constructor(take: (index: number, frame: Float32Array) => void, process: (f: Float32Array) => void, slots = SLOTS) {
    this.take = take
    this.process = process
    this.slots = slots
  }
  send(index: number, frame: Float32Array): boolean {
    if (this.waiting.length >= this.slots) return false
    this.waiting.push({ index, frame: frame.slice() })
    return true
  }
  poll(): void {}
  deliver(): void {
    if (this.stalled) return
    for (const w of this.waiting.splice(0)) {
      this.process(w.frame)
      this.take(w.index, w.frame)
    }
  }
}

/** A tone with a slow sweep: every sample distinct enough to spot a drop or a repeat. */
const signal = (n: number) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i * (0.01 + i * 1e-7)) + 0.1)

/** Runs `input` through a queue in bursts of four render calls; `stall(k)` says whether the worker is stuck at call k. */
function run(input: Float32Array, process: (f: Float32Array) => void, model: number, stall: (k: number) => boolean, slots = SLOTS) {
  const queue = new FrameQueue(DELAY, model)
  const link = new TestLink(queue.take, process, slots)
  queue.attach(link)
  const output = new Float32Array(input.length)
  const out = new Float32Array(BLOCK)
  for (let k = 0; k * BLOCK < input.length; k++) {
    queue.process(input.subarray(k * BLOCK, (k + 1) * BLOCK), out)
    output.set(out, k * BLOCK)
    link.stalled = stall(k)
    if (k % 4 === 3) link.deliver()
  }
  return { queue, output }
}

describe('DeepFilterNet frame queue', () => {
  it('sizes its delay to the render bursts', () => {
    expect(queueDelay(128)).toBe(768)
    expect(queueDelay(480)).toBe(1152) // 10 ms device buffers: 24 ms
    expect(queueDelay(512)).toBe(1152)
    expect(queueDelay(1024)).toBe(1664)
    expect(queueDelay(1e6)).toBe(2048 + 640)
    expect(queueDelay(0)).toBe(768)
  })

  it('plays what the worker sends back at a fixed delay, sample for sample', () => {
    const input = signal(48000 * 5)
    const { queue, output } = run(input, (f) => f.forEach((x, i) => (f[i] = -x)), 0, () => false)
    for (let i = 0; i < output.length; i++) expect(output[i]).toBe(i < DELAY ? 0 : -input[i - DELAY])
    expect(queue.overruns).toBe(0)
    expect(queue.dropped).toBe(0)
    expect(queue.bridged).toBe(0)
  })

  it('a worker that falls behind: bridges with the unprocessed audio, lined up, so nothing is dropped or repeated', () => {
    // The worker passes audio through (like DeepFilterNet at 0 dB): processed and unprocessed are the same samples,
    // so the output must be the input, delayed, whatever the worker does.
    const input = signal(48000 * 5)
    const stuck = (k: number) => (k >= 300 && k < 340) || (k >= 900 && k < 1100) || k % 97 === 0
    const { queue, output } = run(input, () => undefined, 0, stuck)
    expect(queue.overruns).toBeGreaterThan(2)
    expect(queue.dropped).toBeGreaterThan(0) // every slot was out while it was stuck for long
    expect(queue.bridged).toBeGreaterThan(200 * BLOCK) // at least the long stall went out unprocessed
    for (let i = DELAY; i < output.length; i++) expect(output[i]).toBeCloseTo(input[i - DELAY], 6)
  })

  it('crossfades smoothly both ways, and never goes silent', () => {
    // Processed = half the level, with the network's own delay; the unprocessed audio is lined up to match.
    const input = signal(48000 * 5).map((x) => x + 0.5) // never near 0, so the ratio below is defined
    const late = new Float32Array(MODEL_DELAY)
    const process = (f: Float32Array) => {
      // A 1440-sample delay line, like the network's look-ahead.
      const all = new Float32Array(MODEL_DELAY + FRAME)
      all.set(late)
      all.set(f, MODEL_DELAY)
      for (let i = 0; i < FRAME; i++) f[i] = 0.5 * all[i]
      late.set(all.subarray(FRAME))
    }
    const { queue, output } = run(input, process, MODEL_DELAY, (k) => k >= 500 && k < 560)
    expect(queue.overruns).toBe(1)
    const from = DELAY + MODEL_DELAY
    let lo = 1
    let hi = 0
    let steepest = 0
    let prev = 0.5
    for (let i = from; i < output.length; i++) {
      const x = input[i - from]
      const g = output[i] / x // how much of the unprocessed level: 0.5 (processed) to 1 (bridged)
      lo = Math.min(lo, g)
      hi = Math.max(hi, g)
      steepest = Math.max(steepest, Math.abs(g - prev))
      prev = g
    }
    expect(lo).toBeCloseTo(0.5, 5)
    expect(hi).toBeCloseTo(1, 5) // it did bridge
    expect(steepest).toBeLessThan(0.5 / BLOCK + 1e-4) // over a whole render call, never a step
  })

  it('over a real MessagePort: the slot buffers go back and forth', async () => {
    const channel = new MessageChannel()
    const queue = new FrameQueue(DELAY, 0)
    let frames = 0
    channel.port2.onmessage = (e: MessageEvent<Float32Array>) => {
      frames++
      const f = e.data
      for (let i = 0; i < f.length; i++) f[i] *= 2
      channel.port2.postMessage(f, [f.buffer])
    }
    queue.attach(new PortLink(channel.port1, queue.take))
    const input = signal(48000)
    const out = new Float32Array(BLOCK)
    const output = new Float32Array(input.length)
    const tick = () => new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(f: () => void): void }).setImmediate(resolve))
    for (let k = 0; k * BLOCK < input.length; k++) {
      queue.process(input.subarray(k * BLOCK, (k + 1) * BLOCK), out)
      output.set(out, k * BLOCK)
      if (k % 4 === 3) for (let i = 0; i < 4; i++) await tick()
    }
    for (let i = 0; i < 4; i++) await tick()
    channel.port1.close()
    expect(frames).toBe(Math.floor(input.length / FRAME))
    expect(queue.overruns).toBe(0)
    for (let i = DELAY; i < output.length; i++) expect(output[i]).toBe(Math.fround(2 * input[i - DELAY]))
  })

  it('gives up on the worker only when it is late for a good part of several seconds in a row', () => {
    const watch = new BridgeWatch()
    for (let i = 0; i < 20; i++) expect(watch.report(0.05)).toBe(false) // late now and then: fine
    for (let i = 0; i < SLOW_WINDOWS - 1; i++) expect(watch.report(MAX_BRIDGED + 0.1)).toBe(false)
    expect(watch.report(0)).toBe(false) // a good second starts over
    for (let i = 0; i < SLOW_WINDOWS - 1; i++) expect(watch.report(0.9)).toBe(false)
    expect(watch.report(0.9)).toBe(true)
  })
})
