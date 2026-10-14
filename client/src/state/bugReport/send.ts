// Sending a bug report: POST to the bug inbox, with a couple of retries for network trouble and server hiccups.
import { BUG_REPORT_URL } from '../../links'
import type { ReportPayload } from './payload'

export type SendFailure = 'offline' | 'rate' | 'off' | 'invalid' | 'tooLarge' | 'server'

export class BugSendError extends Error {
  readonly reason: SendFailure

  constructor(reason: SendFailure) {
    super(reason)
    this.reason = reason
  }
}

/** Where reports go. Development builds may point it elsewhere (tests send to a local server). */
export function bugReportUrl(): string {
  if (import.meta.env?.DEV) {
    try {
      const override = localStorage.getItem('iskra.bugReportUrl')
      if (override && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(override)) return override
    } catch { /* storage blocked */ }
  }
  return BUG_REPORT_URL
}

const failureFor = (status: number): SendFailure =>
  status === 429 ? 'rate' : status === 404 ? 'off' : status === 413 ? 'tooLarge' : status >= 400 && status < 500 ? 'invalid' : 'server'

export async function sendBugReport(payload: ReportPayload, options: {
  url?: string
  fetch?: typeof fetch
  /** Waits between tries (ms): one more try after each. */
  backoff?: number[]
  sleep?: (ms: number) => Promise<void>
} = {}): Promise<{ id: string }> {
  const doFetch = options.fetch ?? fetch
  const backoff = options.backoff ?? [1000, 4000]
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const body = JSON.stringify(payload)
  let last: SendFailure = 'offline'
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    if (attempt > 0) await sleep(backoff[attempt - 1])
    let response: Response
    try {
      response = await doFetch(options.url ?? bugReportUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
    } catch {
      last = 'offline'
      continue
    }
    if (response.status === 201 || response.ok) {
      const result = (await response.json().catch(() => null)) as { id?: unknown } | null
      const id = typeof result?.id === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(result.id) ? result.id : '—'
      return { id }
    }
    last = failureFor(response.status)
    if (last !== 'server') break // only server errors are worth another try
  }
  throw new BugSendError(last)
}
