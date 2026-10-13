// A server's name before joining it: `GET /` answers `{ iskra: 1, name }` to any origin. Only for display.
import { useEffect, useState } from 'react'

const NAME_MAX = 100
const cache = new Map<string, Promise<string | null>>()

/** Reads a server's name from its `GET /`; null if it can't be reached or doesn't look like Iskra. */
export function fetchServerName(serverUrl: string, timeoutMs = 5000, fetchImpl: typeof fetch = fetch): Promise<string | null> {
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
      const { iskra, name } = body as { iskra?: unknown; name?: unknown }
      if (iskra !== 1 || typeof name !== 'string') return null
      const clean = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
      return clean || null
    })
    .catch(() => null)
}

/** The invited server's name, once it answers (null until then, or if it doesn't). */
export function useServerName(serverUrl: string | null | undefined): string | null {
  const [name, setName] = useState<{ url: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!serverUrl) return
    let live = true
    let pending = cache.get(serverUrl)
    if (!pending) {
      pending = fetchServerName(serverUrl)
      cache.set(serverUrl, pending)
      // A server that didn't answer may be up later.
      void pending.then((n) => { if (n === null) cache.delete(serverUrl) })
    }
    void pending.then((n) => { if (live) setName({ url: serverUrl, name: n }) })
    return () => { live = false }
  }, [serverUrl])
  return name && name.url === serverUrl ? name.name : null
}
