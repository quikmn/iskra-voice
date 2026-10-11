// Catch-up: which summarizer runs, and running it off the main thread when the stretch is long.
// The deterministic summarizer (state/catchupLogic.ts) is the default. Another one (for example an opt-in local AI model)
// registers with `registerSummarizer`; it only runs while `available()` says so, and the panel falls back to the
// deterministic summary if it fails. Nothing here sends messages anywhere.
import { create } from 'zustand'
import { summarize, type CatchUpMessage, type CatchUpSummary } from './catchupLogic'

/** What a summarizer produces: the deterministic summary's shape, optionally with a few sentences of prose. */
export interface CatchUpResult extends CatchUpSummary {
  /** Written by a summarizer that can (none ships yet); shown above the lists. */
  prose?: string
  /** Which summarizer made it. */
  by: string
}

export interface CatchUpSummarizer {
  id: string
  /** Whether it may run right now (opted in, model loaded, …). */
  available(): boolean
  summarize(messages: CatchUpMessage[], signal: AbortSignal): Promise<CatchUpResult>
}

/** Above this many messages the deterministic summary runs in a worker, so the app stays smooth. */
export const WORKER_ABOVE = 400

let worker: Worker | null = null
let nextJob = 0

function inWorker(messages: CatchUpMessage[], signal: AbortSignal): Promise<CatchUpSummary> {
  worker ??= new Worker(new URL('./catchup.worker.ts', import.meta.url), { type: 'module' })
  const w = worker
  const job = ++nextJob
  return new Promise((resolve, reject) => {
    const done = () => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onMessage = (e: MessageEvent<{ job: number; summary: CatchUpSummary }>) => {
      if (e.data.job !== job) return
      done()
      resolve(e.data.summary)
    }
    const onError = (e: ErrorEvent) => {
      done()
      worker = null
      reject(e.error ?? new Error(e.message))
    }
    const onAbort = () => {
      done()
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    signal.addEventListener('abort', onAbort)
    w.postMessage({ job, messages })
  })
}

export const deterministicSummarizer: CatchUpSummarizer = {
  id: 'local',
  available: () => true,
  async summarize(messages, signal) {
    let summary: CatchUpSummary
    if (messages.length > WORKER_ABOVE && typeof Worker !== 'undefined') {
      try {
        summary = await inWorker(messages, signal)
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        summary = summarize(messages) // no workers here: do it on this thread
      }
    } else {
      summary = summarize(messages)
    }
    return { ...summary, by: 'local' }
  },
}

const registry = create<{ extra: CatchUpSummarizer[] }>(() => ({ extra: [] }))

/** Adds a summarizer that's preferred over the deterministic one while it's available. Returns a function that removes it. */
export function registerSummarizer(summarizer: CatchUpSummarizer): () => void {
  registry.setState((s) => ({ extra: [...s.extra.filter((x) => x.id !== summarizer.id), summarizer] }))
  return () => registry.setState((s) => ({ extra: s.extra.filter((x) => x !== summarizer) }))
}

/** The summarizer to use now: the newest available extra one, else the deterministic one. */
export function currentSummarizer(): CatchUpSummarizer {
  return [...registry.getState().extra].reverse().find((s) => s.available()) ?? deterministicSummarizer
}

/** Summarizes with the current summarizer, falling back to the deterministic one if it fails. */
export async function catchUp(messages: CatchUpMessage[], signal: AbortSignal): Promise<CatchUpResult> {
  const chosen = currentSummarizer()
  if (chosen === deterministicSummarizer) return chosen.summarize(messages, signal)
  try {
    return await chosen.summarize(messages, signal)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    return deterministicSummarizer.summarize(messages, signal)
  }
}
