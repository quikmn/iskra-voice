// Invite links: <appUrl>/#/join/<b64u(serverUrl)>.<serverKey>.<code>  (see PROTOCOL.md "Invite links")

export interface InviteLink {
  serverUrl: string
  serverKey: string
  code: string
}

const B64U = /^[A-Za-z0-9_-]+$/

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

/** Accepts a full link, a "#/join/..." hash, or just the "<a>.<b>.<c>" token. */
export function parseInvite(input: string): InviteLink | null {
  const text = input.trim()
  const token = text.includes('/join/') ? text.slice(text.lastIndexOf('/join/') + 6) : text
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((p) => B64U.test(p))) return null
  const [urlPart, serverKey, code] = parts
  if (serverKey.length !== 43 || code.length < 8 || code.length > 64) return null
  let serverUrl: string | null
  try {
    serverUrl = normalizeServerUrl(decodeB64u(urlPart))
  } catch {
    return null
  }
  return serverUrl ? { serverUrl, serverKey, code } : null
}

export function buildInviteLink(appUrl: string, invite: InviteLink): string {
  return `${appUrl.replace(/\/+$/, '')}/#/join/${encodeB64u(invite.serverUrl)}.${invite.serverKey}.${invite.code}`
}

/** ws(s)://host/ws for an http(s) server URL. */
export function socketUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws') + '/ws'
}
