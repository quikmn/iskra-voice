// Where a push notification click takes you. The service worker (public/push-sw.js) builds these routes and the app
// reads them back, from a message or from the "#/open/..." address of a fresh window.

export type OpenTarget =
  | { server: string; kind: 'server' }
  | { server: string; kind: 'channel'; channelId: number }
  | { server: string; kind: 'dm'; peer: string }

const KEY = '[A-Za-z0-9_-]{43}'
const ROUTE = new RegExp(`^#?/open/(${KEY})(?:/c/([1-9][0-9]{0,15})|/dm/(${KEY}))?/?$`)

export function parseOpenRoute(route: string): OpenTarget | null {
  const match = ROUTE.exec(route)
  if (!match) return null
  const [, server, channel, peer] = match
  if (channel) {
    const channelId = Number(channel)
    return Number.isSafeInteger(channelId) ? { server, kind: 'channel', channelId } : null
  }
  if (peer) return { server, kind: 'dm', peer }
  return { server, kind: 'server' }
}

/** The service worker scope for a server's push registration. */
export const pushScope = (serverKey: string) => `/push/${serverKey}/`

/** The server a push registration belongs to, from its scope URL. */
export function serverOfScope(scope: string): string | null {
  const match = new RegExp(`/push/(${KEY})/$`).exec(scope)
  return match ? match[1] : null
}

export type PushSupport = 'supported' | 'needs-install' | 'unsupported'

interface Env {
  userAgent: string
  maxTouchPoints: number
  standalone: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
}

/**
 * Can this browser get push notifications? On iPhone and iPad, only once Iskra is added to the Home Screen and
 * opened from there (iOS 16.4+), so a Safari tab is told how to do that instead.
 */
export function pushSupport(env: Env): PushSupport {
  const ios = /iPad|iPhone|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1)
  const capable = env.hasServiceWorker && env.hasPushManager && env.hasNotification
  if (capable && (!ios || env.standalone)) return 'supported'
  return ios && !env.standalone ? 'needs-install' : 'unsupported'
}
