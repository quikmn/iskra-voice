// Message translation, off the main thread: language detection (ELD) and Bergamot with the models the page hands it
// (already checked against their SHA-256s). It can't fetch anything; text only goes back to the page that asked.
import { sameOriginOnly } from '../localOnly'
import { detectLanguage } from './detect'
import { Bergamot } from './engine'
import { createWorkerCore, type WorkerRequest } from './workerCore'

sameOriginOnly()

const handle = createWorkerCore({ createEngine: (wasm) => Bergamot.create(wasm), detect: detectLanguage })

// One at a time, in order: Bergamot is synchronous and loads must come before the translations that need them.
let queue: Promise<void> = Promise.resolve()
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  queue = queue.then(async () => (self as unknown as Worker).postMessage(await handle(e.data)))
}
