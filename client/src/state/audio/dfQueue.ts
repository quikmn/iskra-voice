// DeepFilterNet off the audio thread, the way its LADSPA plugin does it: the audio worklet only moves samples and a
// worker runs the network. 10 ms frames travel in a fixed set of slots, allocated once and reused: in shared memory
// with Atomics when the page is cross-origin isolated, otherwise as buffers transferred back and forth over a
// MessagePort. The worklet plays the results at a fixed delay; when a frame isn't back in time it crossfades to the
// unprocessed audio (lined up to the same delay) and back once frames arrive again, so nothing is dropped, repeated
// or silenced. Shared by the mic's worklet, the incoming voices' bridge, the worker and the tests. No DOM.

export const FRAME = 480
export const BLOCK = 128
/** DeepFilterNet3's own delay (FFT size - hop + two frames of look-ahead), in samples: 30 ms. */
export const MODEL_DELAY = 1440
/** Frames that can be out at the worker at once. */
export const SLOTS = 8
/** Crossfade between processed and unprocessed audio (samples): one render quantum. */
const FADE = BLOCK
/** Processed frames kept for playing (enough for the longest delay). */
const WET_FRAMES = 16

/**
 * The queue's delay (samples from a frame's first sample going in to it coming out), for render calls that come in
 * bursts of `burst` samples (the device's buffer: the audio thread runs a few 128-sample calls back to back, then
 * waits). 480 to fill a frame, up to 160 more where 480 and 128 don't line up, 128 to see a missing frame coming
 * (so the fade has audio to fade from), and the rest of the burst: a frame finished in one burst is needed in the
 * next one at the earliest, which leaves the worker a whole device period.
 */
export function queueDelay(burst: number): number {
  const b = Math.min(2048, Math.max(BLOCK, Math.ceil(burst / BLOCK) * BLOCK))
  return b + 640
}

/** DeepFilterNet's delay at an attenuation limit (below 0.01 dB it passes the input straight through). */
export const modelDelay = (strength: number): number => (strength < 0.01 ? 0 : MODEL_DELAY)

type Take = (index: number, frame: Float32Array) => void

/** The worklet's end of the slots. */
export interface FrameLink {
  /** Sends a frame off to be processed; false if every slot is out (the worker is behind). */
  send(index: number, frame: Float32Array): boolean
  /** Collects processed frames (shared memory; over a port they arrive by themselves). */
  poll(): void
}

/** Slots as transferred buffers over a MessagePort (works everywhere). */
export class PortLink implements FrameLink {
  private readonly free: Float32Array[] = []
  /** Frame numbers out at the worker, oldest first (it answers in order). */
  private readonly out: Float64Array
  private head = 0
  private pending = 0
  private readonly transfer: Transferable[] = []
  private readonly port: MessagePort

  constructor(port: MessagePort, take: Take, slots = SLOTS) {
    this.port = port
    this.out = new Float64Array(slots)
    for (let i = 0; i < slots; i++) this.free.push(new Float32Array(FRAME))
    port.onmessage = (e: MessageEvent<Float32Array>) => {
      const frame = e.data
      if (!(frame instanceof Float32Array) || frame.length !== FRAME || !this.pending) return
      const index = this.out[this.head]
      this.head = (this.head + 1) % this.out.length
      this.pending--
      take(index, frame)
      this.free.push(frame)
    }
  }

  send(index: number, frame: Float32Array): boolean {
    const slot = this.free.pop()
    if (!slot) return false
    slot.set(frame)
    this.out[(this.head + this.pending) % this.out.length] = index
    this.pending++
    this.transfer[0] = slot.buffer
    this.port.postMessage(slot, this.transfer)
    return true
  }

  poll(): void {}
}

// Shared slots: [sequence, state × n, frame number × n] as Int32, then n frames of samples. Each slot belongs to one
// side at a time: the worklet fills a FREE one (FILLED), the worker processes it in place (DONE), the worklet takes
// the result (FREE again). Both sides go round in the same order.
const FREE = 0
const FILLED = 1
const DONE = 2

interface SlotViews {
  ctrl: Int32Array
  frames: Float32Array[]
}

export function createSlots(slots = SLOTS): SharedArrayBuffer {
  return new SharedArrayBuffer(4 * (1 + 2 * slots) + 4 * FRAME * slots)
}

function slotViews(buffer: SharedArrayBuffer): SlotViews {
  const n = Math.floor(buffer.byteLength / (4 * (2 + FRAME)))
  const ctrl = new Int32Array(buffer, 0, 1 + 2 * n)
  const frames: Float32Array[] = []
  for (let i = 0; i < n; i++) frames.push(new Float32Array(buffer, 4 * (1 + 2 * n) + 4 * FRAME * i, FRAME))
  return { ctrl, frames }
}

/** Slots in shared memory (needs cross-origin isolation): no messages at all while it runs. */
export class SlotLink implements FrameLink {
  private readonly ctrl: Int32Array
  private readonly frames: Float32Array[]
  private readonly n: number
  private write = 0
  private collect = 0
  private readonly take: Take

  constructor(buffer: SharedArrayBuffer, take: Take) {
    const v = slotViews(buffer)
    this.ctrl = v.ctrl
    this.frames = v.frames
    this.n = v.frames.length
    this.take = take
  }

  send(index: number, frame: Float32Array): boolean {
    const s = this.write
    if (Atomics.load(this.ctrl, 1 + s) !== FREE) return false
    this.frames[s].set(frame)
    this.ctrl[1 + this.n + s] = index
    Atomics.store(this.ctrl, 1 + s, FILLED)
    this.write = (s + 1) % this.n
    Atomics.add(this.ctrl, 0, 1)
    Atomics.notify(this.ctrl, 0)
    return true
  }

  poll(): void {
    while (Atomics.load(this.ctrl, 1 + this.collect) === DONE) {
      const c = this.collect
      this.take(this.ctrl[1 + this.n + c], this.frames[c])
      Atomics.store(this.ctrl, 1 + c, FREE)
      this.collect = (c + 1) % this.n
    }
  }
}

// ── The worker's end ─────────────────────────────────────────────────────

/** Processes each frame that comes over `port` in place and sends it back. */
export function servePort(port: MessagePort, process: (frame: Float32Array) => void): () => void {
  const transfer: Transferable[] = []
  port.onmessage = (e: MessageEvent<Float32Array>) => {
    const frame = e.data
    if (!(frame instanceof Float32Array)) return
    process(frame)
    transfer[0] = frame.buffer
    port.postMessage(frame, transfer)
  }
  return () => {
    port.onmessage = null
    port.close()
  }
}

type WaitAsync = (array: Int32Array, index: number, value: number) => { async: boolean; value: Promise<unknown> | string }

/** Processes the shared slots in order as they fill, waiting without blocking the worker's other messages. */
export function serveSlots(buffer: SharedArrayBuffer, process: (frame: Float32Array) => void): () => void {
  const { ctrl, frames } = slotViews(buffer)
  const waitAsync = (Atomics as unknown as { waitAsync: WaitAsync }).waitAsync
  let stopped = false
  let read = 0
  void (async () => {
    while (!stopped) {
      const seq = Atomics.load(ctrl, 0)
      while (!stopped && Atomics.load(ctrl, 1 + read) === FILLED) {
        process(frames[read])
        Atomics.store(ctrl, 1 + read, DONE)
        read = (read + 1) % frames.length
      }
      const w = waitAsync(ctrl, 0, seq)
      if (w.async) await w.value
    }
  })()
  return () => {
    stopped = true
    Atomics.add(ctrl, 0, 1)
    Atomics.notify(ctrl, 0)
  }
}

/** Whether shared slots work here (cross-origin isolated, with Atomics.waitAsync for the worker). */
export function canShareSlots(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean }
  return g.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function' &&
    typeof (Atomics as unknown as { waitAsync?: unknown }).waitAsync === 'function'
}

// ── The worklet's side ───────────────────────────────────────────────────

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(n))

/**
 * Cuts 128-sample render quanta into frames for the worker and plays what comes back `delay` samples later. Keeps
 * the unprocessed input too, lined up with the network's own delay, and crossfades to it over one quantum when the
 * next frame won't be back in time (then back again). Allocates nothing after it's built.
 */
export class FrameQueue {
  readonly delay: number
  private model: number
  private link: FrameLink | null = null
  private readonly frame = new Float32Array(FRAME)
  private filled = 0
  private nextFrame = 0
  /** Input samples so far. */
  private written = 0
  private readonly dry: Float32Array
  private readonly dryMask: number
  private readonly wet = new Float32Array(WET_FRAMES * FRAME)
  private readonly wetIndex = new Float64Array(WET_FRAMES).fill(-1)
  /**
   * Frames that come back right after one that couldn't be sent: the network's look-ahead still held audio from
   * before the gap, so they don't line up (unprocessed audio plays instead).
   */
  private readonly stale = new Float64Array(WET_FRAMES).fill(-1)
  /** 1: processed audio, 0: unprocessed, in between while fading. */
  private mix = 1
  private target = 1
  /** Times the processed audio wasn't going to be back in time (it faded to the unprocessed audio). */
  overruns = 0
  /** Frames that couldn't go out because every slot was busy. */
  dropped = 0

  constructor(delay: number, model = MODEL_DELAY) {
    this.delay = delay
    this.model = model
    this.dry = new Float32Array(nextPow2(delay + MODEL_DELAY + 2 * BLOCK))
    this.dryMask = this.dry.length - 1
  }

  /** Where processed frames come back: hand this to the link. */
  readonly take: Take = (index, frame) => {
    // Too late to be played: the unprocessed audio already went out instead.
    if ((index + 1) * FRAME <= this.written - this.delay) return
    const slot = index % WET_FRAMES
    if (this.stale[slot] === index) return
    this.wet.set(frame, slot * FRAME)
    this.wetIndex[slot] = index
  }

  attach(link: FrameLink): void {
    this.link = link
  }

  /** The network's own delay changed (only at an attenuation limit of 0, which passes the input through). */
  setModelDelay(model: number): void {
    this.model = model
  }

  /** Total delay of what comes out against what went in (samples). */
  get latency(): number {
    return this.delay + this.model
  }

  /** Whether processed samples [from, to) are here (before the first frame counts as silence). */
  private ready(from: number, to: number): boolean {
    if (to <= 0) return true
    const last = Math.floor((to - 1) / FRAME)
    for (let f = Math.max(0, Math.floor(from / FRAME)); f <= last; f++) if (this.wetIndex[f % WET_FRAMES] !== f) return false
    return true
  }

  private dryAt(p: number): number {
    const q = p - this.model
    return q < 0 ? 0 : this.dry[q & this.dryMask]
  }

  private wetAt(p: number): number {
    if (p < 0) return 0
    const f = Math.floor(p / FRAME)
    const slot = f % WET_FRAMES
    return this.wetIndex[slot] === f ? this.wet[slot * FRAME + (p - f * FRAME)] : this.dryAt(p)
  }

  process(input: Float32Array | undefined, output: Float32Array): void {
    this.link?.poll()
    const n = output.length
    const t = this.written
    for (let i = 0; i < n; i++) {
      const x = input ? input[i] : 0
      this.dry[(t + i) & this.dryMask] = x
      this.frame[this.filled++] = x
      if (this.filled === FRAME) {
        this.filled = 0
        if (!this.link?.send(this.nextFrame, this.frame)) {
          this.dropped++
          const after = Math.ceil(this.model / FRAME)
          for (let f = this.nextFrame + 1; f <= this.nextFrame + after; f++) this.stale[f % WET_FRAMES] = f
        }
        this.nextFrame++
      }
    }
    this.written = t + n

    const p0 = t - this.delay
    const here = this.ready(p0, p0 + n)
    const target = here && this.ready(p0 + n, p0 + 2 * n) ? 1 : 0
    if (target === 0 && this.target === 1) this.overruns++
    this.target = target
    if (!here) this.mix = 0 // nothing to fade from (only if frames went missing all at once)
    const step = 1 / FADE
    for (let i = 0; i < n; i++) {
      const p = p0 + i
      if (this.mix !== target) this.mix = target > this.mix ? Math.min(1, this.mix + step) : Math.max(0, this.mix - step)
      if (this.mix === 1) output[i] = this.wetAt(p)
      else if (this.mix === 0) output[i] = this.dryAt(p)
      else {
        const dry = this.dryAt(p)
        output[i] = dry + (this.wetAt(p) - dry) * this.mix
      }
    }
  }
}

type PageMessage = { port: MessagePort } | { slots: SharedArrayBuffer } | { strength: number } | 'stop'

/**
 * Both DeepFilterNet worklets (the mic's and each incoming voice's): take the link to the worker from the page and
 * run the queue. Before the link arrives the mic sends silence, an incoming voice passes through as it is. Says
 * "ready" (with the delay) once linked, and "overrun" whenever a frame wasn't back in time.
 */
export class WorkletQueue {
  stopped = false
  private queue: FrameQueue | null = null
  private readonly port: MessagePort
  private readonly delay: number
  private readonly before: 'silence' | 'input'
  private model = MODEL_DELAY
  private overruns = 0

  constructor(port: MessagePort, delay: number, before: 'silence' | 'input') {
    this.port = port
    this.delay = delay
    this.before = before
  }

  message(data: PageMessage): void {
    if (data === 'stop') {
      this.stopped = true
      return
    }
    if (!data || typeof data !== 'object') return
    if ('strength' in data && typeof data.strength === 'number') {
      this.model = modelDelay(data.strength)
      this.queue?.setModelDelay(this.model)
      return
    }
    const queue = new FrameQueue(this.delay, this.model)
    if ('slots' in data && typeof SharedArrayBuffer === 'function' && data.slots instanceof SharedArrayBuffer) queue.attach(new SlotLink(data.slots, queue.take))
    else if ('port' in data && data.port instanceof MessagePort) queue.attach(new PortLink(data.port, queue.take))
    else return
    this.queue = queue
    this.overruns = 0
    this.port.postMessage({ type: 'ready', latency: queue.delay, transport: 'slots' in data ? 'shared' : 'port' })
  }

  process(input: Float32Array | undefined, output: Float32Array): void {
    const queue = this.queue
    if (!queue) {
      if (input && this.before === 'input') output.set(input)
      else output.fill(0)
      return
    }
    queue.process(input, output)
    if (queue.overruns !== this.overruns) {
      this.overruns = queue.overruns
      this.port.postMessage({ type: 'overrun', overruns: queue.overruns, dropped: queue.dropped })
    }
  }
}
