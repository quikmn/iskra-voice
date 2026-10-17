// Where the assistant may send requests: only the base URL the user configured, over https (plain http only to this
// computer, for local models). The desktop app checks the same rules again in its main process (desktop/src/assistantNet.ts).

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type BaseUrlProblem = 'invalid' | 'https' | 'credentials' | 'query'

/** The cleaned base URL (no trailing slash), or why it can't be used. */
export function checkBaseUrl(raw: string): { ok: true; url: string } | { ok: false; problem: BaseUrlProblem } {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, problem: 'invalid' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, problem: 'invalid' }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) return { ok: false, problem: 'https' }
  if (url.username || url.password) return { ok: false, problem: 'credentials' }
  if (url.search || url.hash) return { ok: false, problem: 'query' }
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` }
}

/** The origin of a base URL ("https://api.openai.com"), or '' when it isn't usable. */
export function originOf(raw: string): string {
  const checked = checkBaseUrl(raw)
  return checked.ok ? new URL(checked.url).origin : ''
}

export const isLocalUrl = (raw: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname)
  } catch {
    return false
  }
}

/** The host a privacy line names ("api.anthropic.com", "this computer"). */
export function providerHost(raw: string): string | null {
  try {
    return new URL(raw).host || null
  } catch {
    return null
  }
}

/** The only endpoints the assistant calls under a base URL. */
export const ENDPOINTS = ['/v1/messages', '/v1/models', '/chat/completions', '/models'] as const
export type Endpoint = (typeof ENDPOINTS)[number]
