// Push in the phone app (mobile/): native push (APNs, FCM) through the Iskra push relay (relay/), because a server
// can't hold Apple's or Google's credentials. The app registers its push token with the relay once per server (the
// handle is bound to that server's VAPID key) and gives the server the endpoint it gets back, like a browser
// subscription. Payloads stay encrypted to the app's own key until the phone decrypts them.
import type { Connection } from '../core/connection'
import type { NativePushRegistration } from '../platform/native'

export const RELAY_URL = 'https://push.iskra.foo'

const CACHE_KEY = 'iskra.relayHandles'
const CACHE_MAX = 50

interface Storage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface RelayDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  storage: Storage | null
  relayUrl: string
}

const defaults = (): RelayDeps => ({
  fetch: (url, init) => fetch(url, init),
  storage: typeof localStorage === 'undefined' ? null : localStorage,
  relayUrl: RELAY_URL,
})

/** The cache key for one token set and server: a new token (or a new server key) needs a new handle. */
export function handleCacheKey(reg: NativePushRegistration, vapidKey: string): string {
  return JSON.stringify([reg.platform, reg.token, reg.voip ?? '', !!reg.sandbox, vapidKey])
}

function readCache(storage: Storage | null): [string, string][] {
  try {
    const parsed = JSON.parse(storage?.getItem(CACHE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') : []
  } catch {
    return []
  }
}

export class RelayError extends Error {}

/** This device's push endpoint for the server with this VAPID key: from the cache, or a new one from the relay. */
export async function relayEndpoint(reg: NativePushRegistration, vapidKey: string, deps: Partial<RelayDeps> = {}): Promise<string> {
  const { fetch: doFetch, storage, relayUrl } = { ...defaults(), ...deps }
  const key = handleCacheKey(reg, vapidKey)
  const cache = readCache(storage)
  const hit = cache.find(([k]) => k === key)
  if (hit) return hit[1]

  const body = { platform: reg.platform, token: reg.token, vapidKey, ...(reg.voip ? { voip: reg.voip } : {}), ...(reg.sandbox ? { sandbox: true } : {}) }
  let response: Response
  try {
    response = await doFetch(`${relayUrl}/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new RelayError('offline')
  }
  const answer = (await response.json().catch(() => ({}))) as { endpoint?: unknown; error?: unknown }
  if (!response.ok || typeof answer.endpoint !== 'string' || !answer.endpoint.startsWith(`${relayUrl}/v1/push/`)) {
    throw new RelayError(typeof answer.error === 'string' ? answer.error : `HTTP ${response.status}`)
  }
  const next = [[key, answer.endpoint] as [string, string], ...cache.filter(([k]) => k !== key)].slice(0, CACHE_MAX)
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(next))
  } catch {
    // Storage full or off: we'll just ask the relay again next time.
  }
  return answer.endpoint
}

/** Makes sure this server has this phone's current native subscription. */
export async function syncNativeServer(connection: Pick<Connection, 'request'>, reg: NativePushRegistration, deps: Partial<RelayDeps> = {}): Promise<void> {
  const status = await connection.request('push.status', {})
  const endpoint = await relayEndpoint(reg, status.publicKey, deps)
  if (status.endpoint === endpoint) return
  await connection.request('push.subscribe', { kind: 'native', endpoint, keys: { p256dh: reg.p256dh, auth: reg.auth } })
}
