// Worker: DeepFilterNet3, off the audio thread. One engine instance, one model state per voice (your mic in a worker
// of its own; incoming voices share one). Each voice's audio worklet sends it 10 ms frames over a port or shared
// slots (dfQueue.ts) and gets them back cleaned, in place. Reports how busy it is (realtime factor, slowest frame).
import { df_process_frame, initSync } from '../../../vendor/deepfilternet/deepfilter.js'
import { createDeepFilter, DF_STRENGTH_DB, setStrength, warmUp } from './strength'
import { serveSlots, servePort } from './dfQueue'

type Message =
  | { type: 'init'; module?: WebAssembly.Module; wasm?: ArrayBuffer; model: ArrayBuffer; reportMs?: number }
  | { type: 'voice'; id: string; strength?: number; port?: MessagePort; slots?: SharedArrayBuffer }
  | { type: 'strength'; id: string; strength: number }
  | { type: 'drop'; id: string }

const voices = new Map<string, { state: number; stop: () => void }>()
/** States of voices that left (about 12 MB each, and the engine can't free them): the next voice reuses one. */
const spare: number[] = []

let model: Uint8Array | null = null
let busyMs = 0
let frames = 0
let slowest = 0
let since = performance.now()
let report: ReturnType<typeof setInterval> | null = null

// A browser that can't send the compiled engine to a worker: ask for the bytes.
self.onmessageerror = () => self.postMessage({ type: 'need-bytes' })

self.onmessage = (e: MessageEvent<Message>) => {
  const m = e.data
  try {
    if (m.type === 'init') {
      if (m.module instanceof WebAssembly.Module) initSync({ module: m.module })
      else if (m.wasm) initSync({ module: m.wasm })
      else return self.postMessage({ type: 'need-bytes' })
      model = new Uint8Array(m.model)
      if (report) clearInterval(report)
      report = setInterval(load, m.reportMs ?? 2000)
      self.postMessage({ type: 'ready' })
    } else if (m.type === 'drop') {
      const voice = voices.get(m.id)
      voices.delete(m.id)
      if (voice) {
        voice.stop()
        spare.push(voice.state)
      }
    } else if (m.type === 'strength') {
      const voice = voices.get(m.id)
      if (voice) setStrength(voice.state, m.strength)
    } else if (m.type === 'voice' && model) {
      const strength = m.strength ?? DF_STRENGTH_DB.normal
      let state = spare.pop()
      if (state === undefined) {
        state = createDeepFilter(model, strength)
        warmUp(state, df_process_frame)
      } else setStrength(state, strength)
      const voiceState = state
      const process = (frame: Float32Array) => {
        const t = performance.now()
        frame.set(df_process_frame(voiceState, frame))
        const took = performance.now() - t
        busyMs += took
        frames++
        if (took > slowest) slowest = took
      }
      const stop = m.slots ? serveSlots(m.slots, process) : m.port ? servePort(m.port, process) : null
      if (!stop) return
      voices.set(m.id, { state: voiceState, stop })
      self.postMessage({ type: 'voice-ready', id: m.id })
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: 'id' in m ? m.id : undefined, message: String((err as Error)?.message ?? err) })
  }
}

/** Realtime factor (time spent / audio processed), how busy the worker was, and its slowest frame (ms). */
function load(): void {
  const now = performance.now()
  if (frames > 0) self.postMessage({ type: 'load', rtf: busyMs / (frames * 10), busy: busyMs / (now - since), slowest })
  busyMs = 0
  frames = 0
  slowest = 0
  since = now
}
