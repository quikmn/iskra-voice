// The assistant's requests to the user's AI provider, sent from the main process (a page can't reach most providers
// because of CORS). Not a general proxy: only https (plain http only to this computer), only the provider endpoints the
// assistant uses, only a few headers, no redirects, size and time limits. The page decides the address (the user's
// own setting); nothing goes anywhere else, and nothing here keeps or logs the key or the content.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const PATHS = [/\/v1\/messages$/, /\/v1\/models$/, /\/chat\/completions$/, /\/models$/]
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

/** The request as it may be sent, or null. */
export function checkAssistantRequest(raw: unknown): AssistantRequest | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.url !== 'string' || (r.method !== 'GET' && r.method !== 'POST')) return null
  let url: URL
  try {
    url = new URL(r.url)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) return null
  if (url.username || url.password || url.search || url.hash) return null
  if (!PATHS.some((p) => p.test(url.pathname))) return null
  const headers: Record<string, string> = {}
  if (r.headers && typeof r.headers === 'object') {
    for (const [key, value] of Object.entries(r.headers as Record<string, unknown>)) {
      const name = key.toLowerCase()
      if (HEADERS.has(name) && typeof value === 'string' && value.length < 4096 && !/[\r\n]/.test(value)) headers[name] = value
    }
  }
  if (r.method === 'POST' && (typeof r.body !== 'string' || r.body.length > MAX_REQUEST)) return null
  return { url: url.toString(), method: r.method, headers, ...(r.method === 'POST' ? { body: r.body as string } : {}) }
}

export async function sendAssistantRequest(raw: unknown, fetcher: typeof fetch = fetch): Promise<AssistantReply> {
  const request = checkAssistantRequest(raw)
  if (!request) return { ok: false, error: 'blocked' }
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    const response = await fetcher(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'error', signal: timeout })
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_RESPONSE) return { ok: false, error: 'too-big' }
    const body = await response.text()
    if (body.length > MAX_RESPONSE) return { ok: false, error: 'too-big' }
    return { ok: true, status: response.status, body }
  } catch {
    return { ok: false, error: timeout.aborted ? 'timeout' : 'network' }
  }
}
