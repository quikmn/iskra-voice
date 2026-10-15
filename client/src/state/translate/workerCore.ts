// The translate worker's messages, apart from the worker itself (so tests can drive it with a fake engine).
// Requests carry an id; every request gets exactly one reply with the same id.
import type { Detection } from './detect'
import { translateText, type Engine, type PairFiles } from './engine'

export type WorkerRequest =
  | { id: number; type: 'detect'; text: string; prefer: string[] }
  | { id: number; type: 'init'; wasm: ArrayBuffer }
  | { id: number; type: 'has'; pairs: string[] }
  | { id: number; type: 'load'; pair: string; files: PairFiles }
  | { id: number; type: 'translate'; text: string; route: string[] }

export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }

/** Longest text the worker takes (a message is at most 4000 characters; with room for its plain-text form). */
export const MAX_TEXT = 8000

export interface WorkerDeps {
  createEngine(wasm: ArrayBuffer): Promise<Engine>
  detect(text: string, prefer: string[]): Promise<Detection>
}

export function createWorkerCore(deps: WorkerDeps): (m: WorkerRequest) => Promise<WorkerReply> {
  let engine: Promise<Engine> | null = null
  const ready = async () => {
    if (!engine) throw new Error('not started')
    return engine
  }
  const run = async (m: WorkerRequest): Promise<unknown> => {
    switch (m.type) {
      case 'detect':
        if (typeof m.text !== 'string' || m.text.length > MAX_TEXT) throw new Error('bad text')
        return deps.detect(m.text, m.prefer ?? [])
      case 'init':
        engine ??= deps.createEngine(m.wasm)
        engine.catch(() => {
          engine = null
        })
        await engine
        return true
      case 'has': {
        const e = await ready()
        return m.pairs.filter((p) => e.has(p))
      }
      case 'load':
        ;(await ready()).load(m.pair, m.files)
        return true
      case 'translate':
        if (typeof m.text !== 'string' || m.text.length > MAX_TEXT) throw new Error('bad text')
        return translateText(await ready(), m.text, m.route)
      default:
        throw new Error('unknown request')
    }
  }
  return async (m) => {
    try {
      return { id: m.id, ok: true, result: await run(m) }
    } catch (e) {
      return { id: m.id, ok: false, error: (e as Error)?.message ?? String(e) }
    }
  }
}
