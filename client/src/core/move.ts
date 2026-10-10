// "This server moved": a notice signed with the server key (see "Moving a server" in PROTOCOL.md).
import { fromB64u, signedPayload, u64be, verify } from './crypto'
import type { MoveNotice } from './protocol'

export const MOVE_CONTEXT = 'iskra/server-moved/v1'

/** An absolute http(s) address without credentials, query or fragment, and no trailing slash; null if it isn't one. */
export function cleanServerUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.length > 512) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '')
}

/** True only for a notice signed by the server key we already trust, pointing at a usable address. */
export function verifyMoveNotice(notice: unknown, trustedServerKey: string): notice is MoveNotice {
  if (!notice || typeof notice !== 'object') return false
  const n = notice as Partial<MoveNotice>
  if (typeof n.url !== 'string' || typeof n.sig !== 'string' || typeof n.serverKey !== 'string' || typeof n.movedAt !== 'number') return false
  if (n.serverKey !== trustedServerKey || !Number.isSafeInteger(n.movedAt) || n.movedAt < 0) return false
  if (cleanServerUrl(n.url) !== n.url) return false
  try {
    const key = fromB64u(trustedServerKey)
    const payload = signedPayload(MOVE_CONTEXT, key, u64be(n.movedAt), new TextEncoder().encode(n.url))
    return verify(fromB64u(n.sig), payload, key)
  } catch {
    return false
  }
}

/** Two addresses for the same place (ignores a trailing slash and letter case in the host). */
export function sameServerUrl(a: string, b: string): boolean {
  const ca = cleanServerUrl(a)
  const cb = cleanServerUrl(b)
  return !!ca && !!cb && ca.toLowerCase() === cb.toLowerCase()
}

/**
 * Connects to `url` just long enough to read its `hello` and returns the server key it announces, or null.
 * Used to check that a new address really is the same server before telling everyone to go there.
 */
export function probeServerKey(url: string, timeoutMs = 6000, Impl: typeof WebSocket = WebSocket): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: WebSocket
    try {
      socket = new Impl(`${url.replace(/^http/, 'ws')}/ws`)
    } catch {
      resolve(null)
      return
    }
    const done = (key: string | null) => {
      clearTimeout(timer)
      try {
        socket.close(1000)
      } catch {
        /* already closed */
      }
      resolve(key)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { type?: string; body?: { serverKey?: unknown } }
        done(frame.type === 'hello' && typeof frame.body?.serverKey === 'string' ? frame.body.serverKey : null)
      } catch {
        done(null)
      }
    }
    socket.onerror = () => done(null)
    socket.onclose = () => done(null)
  })
}
