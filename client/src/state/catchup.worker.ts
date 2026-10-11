// Runs the deterministic catch-up summary off the main thread (see state/catchup.ts).
import { summarize, type CatchUpMessage } from './catchupLogic'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ job: number; messages: CatchUpMessage[] }>) => void) | null
  postMessage: (data: unknown) => void
}

scope.onmessage = (e) => {
  const { job, messages } = e.data
  scope.postMessage({ job, summary: summarize(messages) })
}
