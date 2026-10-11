// Where a push notification click takes you. The service worker (public/push-sw.js) builds these routes and the app
// reads them back, from a message or from the "#/open/..." address of a fresh window.

export type OpenTarget =
  | { server: string; kind: 'server' }
  | { server: string; kind: 'channel'; channelId: number; messageId?: number; pageId?: number }
  | { server: string; kind: 'dm'; peer: string }
  | { server: string; kind: 'group'; group: string }

const KEY = '[A-Za-z0-9_-]{43}'
const ID = '[1-9][0-9]{0,15}'
const ROUTE = new RegExp(`^#?/open/(${KEY})(?:/c/(${ID})(?:/m/(${ID})|/p/(${ID}))?|/dm/(${KEY})|/g/([A-Za-z0-9_-]{22}))?/?$`)

export function parseOpenRoute(route: string): OpenTarget | null {
  const match = ROUTE.exec(route)
  if (!match) return null
  const [, server, channel, message, page, peer, group] = match
  if (channel) {
    const channelId = Number(channel)
    const messageId = message ? Number(message) : undefined
    if (!Number.isSafeInteger(channelId) || (messageId !== undefined && !Number.isSafeInteger(messageId))) return null
    if (page) return Number.isSafeInteger(Number(page)) ? { server, kind: 'channel', channelId, pageId: Number(page) } : null
    return messageId ? { server, kind: 'channel', channelId, messageId } : { server, kind: 'channel', channelId }
  }
  if (peer) return { server, kind: 'dm', peer }
  if (group) return { server, kind: 'group', group }
  return { server, kind: 'server' }
}

/** A link to one message, for "Copy message link": opens the app (or this one) right at it. */
export function messageLink(appBase: string, server: string, channelId: number, messageId: number): string {
  return `${appBase.replace(/\/+$/, '')}/#/open/${server}/c/${channelId}/m/${messageId}`
}

/** A link to a docs page: opens the app (or this one) at the page. */
export function pageLink(appBase: string, server: string, channelId: number, pageId: number): string {
  return `${appBase.replace(/\/+$/, '')}/#/open/${server}/c/${channelId}/p/${pageId}`
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
