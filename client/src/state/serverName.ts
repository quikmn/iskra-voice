// A server's name (and icon) before joining it: `GET /` answers `{ iskra: 1, name, icon }` to any origin, and `GET /icon`
// serves the icon alone. Only for display.
import { useEffect, useState } from 'react'

const NAME_MAX = 100

export interface ServerInfo {
  name: string
  /** The icon's address (`/icon?v=<stamp>` on the server), or null without one. */
  icon: string | null
}

const cache = new Map<string, Promise<ServerInfo | null>>()

/** Reads a server's name and icon from its `GET /`; null if it can't be reached or doesn't look like Iskra. */
export function fetchServerInfo(serverUrl: string, timeoutMs = 5000, fetchImpl: typeof fetch = fetch): Promise<ServerInfo | null> {
  let url: URL
  try {
    url = new URL('/', serverUrl)
  } catch {
    return Promise.resolve(null)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Promise.resolve(null)
  return fetchImpl(url.href, { signal: AbortSignal.timeout(timeoutMs), credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then(async (response) => {
      if (!response.ok) return null
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object') return null
      const { iskra, name, icon } = body as { iskra?: unknown; name?: unknown; icon?: unknown }
      if (iskra !== 1 || typeof name !== 'string') return null
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
      if (!clean) return null
      // The stamp only ever names a version of the icon; anything else is ignored.
      const iconUrl = typeof icon === 'string' && /^[0-9a-f]{16}$/.test(icon) ? new URL(`/icon?v=${icon}`, url).href : null
      return { name: clean, icon: iconUrl }
    })
    .catch(() => null)
}

/** Reads a server's name from its `GET /`; null if it can't be reached or doesn't look like Iskra. */
export function fetchServerName(serverUrl: string, timeoutMs = 5000, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  return fetchServerInfo(serverUrl, timeoutMs, fetchImpl).then((info) => info?.name ?? null)
}

/** The invited server's name and icon: undefined while asking, null if it can't be reached or has none to show. */
export function useServerInfo(serverUrl: string | null | undefined): ServerInfo | null | undefined {
  const [info, setInfo] = useState<{ url: string; info: ServerInfo | null } | null>(null)
  useEffect(() => {
    if (!serverUrl) return
    let live = true
    let pending = cache.get(serverUrl)
    if (!pending) {
      pending = fetchServerInfo(serverUrl)
      cache.set(serverUrl, pending)
      // A server that didn't answer may be up later.
      void pending.then((n) => { if (n === null) cache.delete(serverUrl) })
    }
    void pending.then((n) => { if (live) setInfo({ url: serverUrl, info: n }) })
    return () => { live = false }
  }, [serverUrl])
  if (!serverUrl) return null
  return info && info.url === serverUrl ? info.info : undefined
}

/** The invited server's name: undefined while asking, null if it can't be reached or has none to show. */
export function useServerName(serverUrl: string | null | undefined): string | null | undefined {
  const info = useServerInfo(serverUrl)
  return info === undefined ? undefined : info?.name ?? null
}
