// Invite links: <appUrl>/#/join/<b64u(serverUrl)>.<serverKey>.<code>[.<p2p>]  (see PROTOCOL.md "Invite links")
// The optional fourth field is the server's p2p secret: friends' desktop apps reach the server through a
// peer-to-peer tunnel with it when its address can't be reached ("Connecting without port forwarding").

export interface InviteLink {
  serverUrl: string
  serverKey: string
  code: string
  /** The p2p secret (43 b64u characters), when the server lets friends connect without port forwarding. */
  p2p?: string
}

const B64U = /^[A-Za-z0-9_-]+$/
/** A 32-byte key or secret as b64u. */
export const KEY43 = /^[A-Za-z0-9_-]{43}$/

function encodeB64u(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeB64u(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

/** Only http(s) servers, normalized without a trailing slash. */
export function normalizeServerUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search || url.hash) return null
    return url.origin + url.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** Accepts a full link, a "#/join/..." hash, or just the "<a>.<b>.<c>[.<d>]" token. */
export function parseInvite(input: string): InviteLink | null {
  const text = input.trim()
  const token = text.includes('/join/') ? text.slice(text.lastIndexOf('/join/') + 6) : text
  const parts = token.split('.')
  if ((parts.length !== 3 && parts.length !== 4) || !parts.every((p) => B64U.test(p))) return null
  const [urlPart, serverKey, code, p2p] = parts
  if (!KEY43.test(serverKey) || code.length < 8 || code.length > 64) return null
  if (p2p !== undefined && !KEY43.test(p2p)) return null
  let serverUrl: string | null
  try {
    serverUrl = normalizeServerUrl(decodeB64u(urlPart))
  } catch {
    return null
  }
  if (!serverUrl) return null
  return p2p ? { serverUrl, serverKey, code, p2p } : { serverUrl, serverKey, code }
}

function inviteToken(invite: InviteLink): string {
  const token = `${encodeB64u(invite.serverUrl)}.${invite.serverKey}.${invite.code}`
  return invite.p2p && KEY43.test(invite.p2p) ? `${token}.${invite.p2p}` : token
}

export function buildInviteLink(appUrl: string, invite: InviteLink): string {
  return `${appUrl.replace(/\/+$/, '')}/#/join/${inviteToken(invite)}`
}

/** The same invite as an iskra:// link, which opens the desktop app (it accepts nothing but invites). */
export function appInviteLink(invite: InviteLink): string {
  return `iskra://join/${inviteToken(invite)}`
}

/** ws(s)://host/ws for an http(s) server URL. */
export function socketUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws') + '/ws'
}
