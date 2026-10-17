// The assistant's requests to the user's AI provider, sent from the main process (a page can't reach most providers
// because of CORS). Not a general proxy: the page registers the provider address the user saved (setBase, kept in the
// app's data folder), and only that address's few provider endpoints are reachable: https (plain http only to this
// computer), a few headers, no redirects, size and time limits. Nothing here keeps or logs the key or the content.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const HEADERS = new Set(['content-type', 'x-api-key', 'anthropic-version', 'authorization'])
export const MAX_REQUEST = 2 * 1024 * 1024
export const MAX_RESPONSE = 4 * 1024 * 1024
export const TIMEOUT_MS = 120_000

export interface AssistantRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

export type AssistantReply = { ok: true; status: number; body: string } | { ok: false; error: 'blocked' | 'network' | 'timeout' | 'too-big' }

/** A provider base address as the page saves it (no trailing slash), or null when it isn't one. */
export function checkBase(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) return null
  if (url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Exactly the endpoints the assistant calls under a base (as the page builds them: client/src/state/assistant/providers.ts). */
export function endpointsFor(base: string): string[] {
  const v1 = base.endsWith('/v1')
  return [
    v1 ? `${base}/messages` : `${base}/v1/messages`,
    v1 ? `${base}/models` : `${base}/v1/models`,
    `${base}/chat/completions`,
    `${base}/models`,
  ]
}

/** The request as it may be sent to the registered base, or null. */
export function checkAssistantRequest(raw: unknown, base: string | null): AssistantRequest | null {
  if (!base) return null
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.url !== 'string' || (r.method !== 'GET' && r.method !== 'POST')) return null
  if (!endpointsFor(base).includes(r.url)) return null
  const headers: Record<string, string> = {}
  if (r.headers && typeof r.headers === 'object') {
    for (const [key, value] of Object.entries(r.headers as Record<string, unknown>)) {
      const name = key.toLowerCase()
      if (HEADERS.has(name) && typeof value === 'string' && value.length < 4096 && !/[\r\n]/.test(value)) headers[name] = value
    }
  }
  if (r.method === 'POST' && (typeof r.body !== 'string' || r.body.length > MAX_REQUEST)) return null
  return { url: r.url, method: r.method, headers, ...(r.method === 'POST' ? { body: r.body as string } : {}) }
}

/** Reads at most `max` bytes; null when there are more. */
export async function readCapped(response: Response, max: number): Promise<string | null> {
  if (Number(response.headers.get('content-length') ?? 0) > max) return null
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function sendAssistantRequest(raw: unknown, base: string | null, fetcher: typeof fetch = fetch): Promise<AssistantReply> {
  const request = checkAssistantRequest(raw, base)
  if (!request) return { ok: false, error: 'blocked' }
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    const response = await fetcher(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'error', signal: timeout })
    const body = await readCapped(response, MAX_RESPONSE)
    if (body === null) return { ok: false, error: 'too-big' }
    return { ok: true, status: response.status, body }
  } catch {
    return { ok: false, error: timeout.aborted ? 'timeout' : 'network' }
  }
}

/** The registered base, kept in the app's data folder (assistant.json) so it holds before the page has loaded. */
export class AssistantBase {
  #file: string
  #base: string | null = null

  constructor(file: string) {
    this.#file = file
    try {
      this.#base = checkBase((JSON.parse(readFileSync(file, 'utf8')) as { base?: unknown }).base)
    } catch {
      this.#base = null
    }
  }

  get current(): string | null {
    return this.#base
  }

  set(raw: unknown): void {
    this.#base = raw === null ? null : checkBase(raw)
    try {
      if (this.#base) writeFileSync(this.#file, JSON.stringify({ base: this.#base }))
      else rmSync(this.#file, { force: true })
    } catch {
      /* kept in memory for this run */
    }
  }
}
