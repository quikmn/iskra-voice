// The page's side of DeepFilterNet3: starts the worker (deepfilter.worker.ts) and links voices to it, each through
// its audio worklet node (dfQueue.ts). Shared slots when the page is cross-origin isolated, a MessagePort otherwise.
import { loadDeepFilter, deepFilterBytes } from './assets'
import { canShareSlots, createSlots, queueDelay } from './dfQueue'

export interface WorkerLoad {
  /** Time spent / audio processed. */
  rtf: number
  /** Share of the worker's time spent processing. */
  busy: number
  /** The slowest frame since the last report (ms). */
  slowest: number
}

/** The delay for an AudioContext's queue: its render bursts are about as long as its base latency. */
export const contextDelay = (ctx: BaseAudioContext): number =>
  queueDelay(((ctx as AudioContext).baseLatency || 0.01) * ctx.sampleRate)

export class DeepFilterWorker {
  private readonly worker: Worker
  private readonly waiting = new Map<string, (ok: boolean) => void>()
  private nextId = 0

  private constructor(worker: Worker, onLoad: (load: WorkerLoad) => void, onError: (message: string) => void) {
    this.worker = worker
    worker.onmessage = (e: MessageEvent<{ type: string; id?: string; message?: string } & Partial<WorkerLoad>>) => {
      const m = e.data
      if (m.type === 'load' && typeof m.rtf === 'number') onLoad({ rtf: m.rtf, busy: m.busy ?? 0, slowest: m.slowest ?? 0 })
      else if (m.type === 'voice-ready' && m.id) this.settle(m.id, true)
      else if (m.type === 'error') {
        onError(m.message ?? 'error')
        if (m.id) this.settle(m.id, false)
      }
    }
  }

  /** Starts the engine in a new worker; throws why it couldn't (an error, or it took longer than `ms`). */
  static async start(opts: { reportMs: number; ms: number; onLoad: (load: WorkerLoad) => void; onError: (message: string) => void }): Promise<DeepFilterWorker> {
    const assets = await loadDeepFilter()
    const worker = new Worker(new URL('./deepfilter.worker.ts', import.meta.url), { type: 'module' })
    const started = Date.now()
    const failure = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(`the engine took longer than ${opts.ms} ms to start in its worker`), opts.ms)
      const done = (why: string | null) => {
        clearTimeout(timer)
        resolve(why)
      }
      worker.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
        if (e.data.type === 'ready') done(null)
        else if (e.data.type === 'error') done(`the engine failed in its worker: ${e.data.message}`)
        else if (e.data.type === 'need-bytes') {
          // This browser can't send it the compiled engine: send the bytes.
          void deepFilterBytes().then((wasm) => worker.postMessage({ type: 'init', wasm, model: assets.model, reportMs: opts.reportMs }),
            (e) => done(`couldn't get the engine's bytes: ${e}`))
        }
      }
      worker.onerror = (e) => done(`the worker couldn't run: ${e.message || 'error'}`)
      worker.postMessage({ type: 'init', module: assets.module, model: assets.model, reportMs: opts.reportMs })
    })
    if (failure) {
      worker.terminate()
      throw new Error(`${failure} (after ${Date.now() - started} ms)`)
    }
    return new DeepFilterWorker(worker, opts.onLoad, opts.onError)
  }

  /**
   * Gives a voice a model state in the worker and links `node` (an iskra-deepfilter or iskra-df-bridge worklet) to
   * it; resolves to the voice's id once frames can flow, or null (with a warning saying why).
   */
  async link(node: AudioWorkletNode, strength: number, ms = 6000): Promise<string | null> {
    const id = String(++this.nextId)
    const started = Date.now()
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[iskra] DeepFilterNet: the model took longer than ${ms} ms to load in its worker`)
        this.settle(id, false)
      }, ms)
      this.waiting.set(id, (ok) => {
        clearTimeout(timer)
        if (ok) console.info(`[iskra] DeepFilterNet: model loaded in ${Date.now() - started} ms`)
        resolve(ok)
      })
    })
    node.port.postMessage({ strength }) // first, so the queue starts with the network's delay
    if (canShareSlots()) {
      const slots = createSlots()
      this.worker.postMessage({ type: 'voice', id, strength, slots })
      if (!(await ready)) return this.fail(id)
      node.port.postMessage({ slots })
    } else {
      const channel = new MessageChannel()
      this.worker.postMessage({ type: 'voice', id, strength, port: channel.port2 }, [channel.port2])
      if (!(await ready)) return this.fail(id)
      node.port.postMessage({ port: channel.port1 }, [channel.port1])
    }
    return id
  }

  strength(id: string, node: AudioWorkletNode, strength: number): void {
    this.worker.postMessage({ type: 'strength', id, strength })
    node.port.postMessage({ strength })
  }

  drop(id: string): void {
    this.worker.postMessage({ type: 'drop', id })
  }

  terminate(): void {
    this.worker.terminate()
    for (const id of [...this.waiting.keys()]) this.settle(id, false)
  }

  private settle(id: string, ok: boolean): void {
    const resolve = this.waiting.get(id)
    this.waiting.delete(id)
    resolve?.(ok)
  }

  private fail(id: string): null {
    this.drop(id)
    return null
  }
}
