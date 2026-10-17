// Outgoing webhooks: the checks the app makes before asking the server (which checks everything again), and how a
// delivery reads in the log. See "Outgoing webhooks" in PROTOCOL.md.
import type { OutHookDelivery, OutHookEvent } from '../core/protocol'

export const OUTHOOK_EVENTS: OutHookEvent[] = [
  'message.created', 'message.updated', 'message.deleted', 'reaction.added', 'thread.created', 'voice.joined', 'voice.left',
  'member.joined', 'member.left', 'member.updated', 'role.created', 'role.updated', 'role.deleted',
  'channel.created', 'channel.updated', 'channel.deleted', 'event.started',
]

/** Events about what happens in channels (the server refuses them without channels). */
export const CHANNEL_EVENTS: OutHookEvent[] = ['message.created', 'message.updated', 'message.deleted', 'reaction.added', 'thread.created', 'voice.joined', 'voice.left']

/** Events that need channels to be picked. */
export const needsChannels = (events: OutHookEvent[]): boolean => events.some((e) => CHANNEL_EVENTS.includes(e))

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[f[cd][0-9a-f]{2}:|\[::1\])/i

/** The server's error key for an address it would refuse right away, or null if it looks fine. */
export function urlProblem(url: string, allowLocal: boolean): string | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return 'outhook_url'
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) return 'outhook_url'
  if (parsed.username || parsed.password) return 'outhook_url_userinfo'
  if (parsed.protocol === 'http:' && !allowLocal) return 'outhook_url_http'
  if (url.length > 512) return 'outhook_url'
  if (/^(169\.254\.|\[fe[89ab][0-9a-f]:)/i.test(parsed.host)) return 'outhook_address_reserved'
  if (!allowLocal && PRIVATE_HOST.test(parsed.host)) return 'outhook_address_private'
  return null
}

/** The host part, for lists ("mc.example.com"). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** A log line's kind: delivered, will be or was retried, or failed for good. */
export function deliveryState(d: OutHookDelivery): 'ok' | 'retry' | 'failed' {
  if (d.outcome === 'ok') return 'ok'
  const retried = d.outcome === 'timeout' || d.outcome === 'network' || (d.outcome === 'http' && d.status !== null && (d.status === 408 || d.status === 429 || d.status >= 500))
  return retried ? 'retry' : 'failed'
}
