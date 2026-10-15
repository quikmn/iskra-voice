// The page's side of the translate worker: requests with ids, one reply each.
import type { Detection } from './detect'
import type { PairFiles } from './engine'
import type { WorkerReply, WorkerRequest } from './workerCore'

/** What talks to the worker (a Worker, or a fake in tests). */
export interface WorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null
  onerror?: ((e: ErrorEvent) => void) | null
  terminate(): void
}

type Body<T> = T extends { id: number } ? Omit<T, 'id'> : never

export class TranslatorClient {
  private next = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private readonly port: WorkerPort

  constructor(port: WorkerPort) {
    this.port = port
    port.onmessage = (e) => {
      const waiting = this.pending.get(e.data.id)
      if (!waiting) return
      this.pending.delete(e.data.id)
      if (e.data.ok) waiting.resolve(e.data.result)
      else waiting.reject(new Error(e.data.error))
    }
    port.onerror = (e) => this.fail(new Error(e.message || 'translate worker failed'))
  }

  private request<T>(body: Body<WorkerRequest>, transfer: Transferable[] = []): Promise<T> {
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.port.postMessage({ ...body, id }, transfer)
    })
  }

  detect(text: string, prefer: string[]): Promise<Detection> {
    return this.request({ type: 'detect', text, prefer })
  }

  init(wasm: ArrayBuffer): Promise<boolean> {
    return this.request({ type: 'init', wasm }, [wasm])
  }

  has(pairs: string[]): Promise<string[]> {
    return this.request({ type: 'has', pairs })
  }

  load(pair: string, files: PairFiles): Promise<boolean> {
    return this.request({ type: 'load', pair, files }, [files.model.buffer, files.lex.buffer, files.vocab.buffer] as ArrayBuffer[])
  }

  translate(text: string, route: string[]): Promise<string> {
    return this.request({ type: 'translate', text, route })
  }

  /** Everything still waiting fails (the worker is gone). */
  fail(error: Error): void {
    for (const waiting of this.pending.values()) waiting.reject(error)
    this.pending.clear()
  }

  terminate(): void {
    this.fail(new Error('stopped'))
    this.port.terminate()
  }
}
