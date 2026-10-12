// Worker: DeepFilterNet3 for incoming voices ("Clean up others' audio"). One engine instance, one model state per
// voice; each voice's audio worklet node talks to it over its own port (10 ms frames in, cleaned frames out).
// Reports how busy it is (its realtime factor) every two seconds.
import { df_create, df_process_frame, initSync } from '../../../vendor/deepfilternet/deepfilter.js'

type Message =
  | { type: 'init'; module: WebAssembly.Module; model: ArrayBuffer }
  | { type: 'voice'; id: string; port: MessagePort }
  | { type: 'drop'; id: string }

const voices = new Map<string, { state: number; port: MessagePort }>()
/** States of voices that left (about 12 MB each, and the engine can't free them): the next voice reuses one. */
const spare: number[] = []

let model: Uint8Array | null = null
let busyMs = 0
let since = performance.now()
let audioMs = 0

self.onmessage = (e: MessageEvent<Message>) => {
  const m = e.data
  try {
    if (m.type === 'init') {
      initSync({ module: m.module })
      model = new Uint8Array(m.model)
      self.postMessage({ type: 'ready' })
    } else if (m.type === 'drop') {
      const voice = voices.get(m.id)
      voices.delete(m.id)
      if (voice) {
        voice.port.close()
        spare.push(voice.state)
      }
    } else if (m.type === 'voice' && model) {
      const state = spare.pop() ?? df_create(model, 100)
      const port = m.port
      voices.set(m.id, { state, port })
      port.onmessage = (f: MessageEvent<Float32Array>) => {
        const t = performance.now()
        const out = df_process_frame(state, f.data)
        busyMs += performance.now() - t
        audioMs += 10
        port.postMessage(out, [out.buffer])
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) })
  }
}

setInterval(() => {
  const now = performance.now()
  if (audioMs > 0) self.postMessage({ type: 'load', rtf: busyMs / audioMs, busy: busyMs / (now - since) })
  busyMs = 0
  audioMs = 0
  since = now
}, 2000)
