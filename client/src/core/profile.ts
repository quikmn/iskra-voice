// Profiles: limits, hashing, and the sandbox documents used to show profile pages.
// Safety model: protocol/PROTOCOL.md, "Profiles".
import sodium from 'libsodium-wrappers-sumo'
import type { Profile } from './storage'

export const MAX_BIO = 190
export const MAX_PRONOUNS = 40
export const MAX_PAGE_BYTES = 512 * 1024
export const AVATAR_SIZE = 256
export const ACCENT_PATTERN = /^#[0-9a-f]{6}$/i

/** Hex SHA-256, the same hash the server reports as avatarHash / pageHash. */
export function sha256Hex(bytes: Uint8Array): string {
  return sodium.to_hex(sodium.crypto_hash_sha256(bytes))
}

export const utf8Length = (text: string) => new TextEncoder().encode(text).length

/** The text fields sent with auth on every connect (only the ones set on this device). */
export function authProfile(profile: Profile | null | undefined): { bio?: string; pronouns?: string; accent?: string } {
  const out: { bio?: string; pronouns?: string; accent?: string } = {}
  if (profile?.bio !== undefined) out.bio = profile.bio
  if (profile?.pronouns !== undefined) out.pronouns = profile.pronouns
  if (profile?.accent !== undefined) out.accent = profile.accent
  return out
}

/** A server URL's origin, or null if it isn't a plain http(s) URL. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

const escapeAttribute = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Same lock as the server's prelude: no WebRTC (CSP doesn't cover it). */
export const PAGE_PRELUDE =
  '<script>(()=>{for(const k of["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceTransport","WebTransport"])' +
  'try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch{}})()</script>'

/** The page policy without the parts only a response header can carry (sandbox, frame-ancestors). */
export function pagePolicy(imageOrigin: string | null): string {
  return (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    `img-src data: blob:${imageOrigin ? ` ${imageOrigin}/files/` : ''}; font-src data:; media-src 'none'; ` +
    "connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'"
  )
}

/**
 * The editor's live preview: the user's HTML with the page policy and prelude in front.
 * It runs in the same sandbox as a published page (see PageFrame).
 */
export function previewDocument(html: string, imageOrigin: string | null): string {
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(pagePolicy(imageOrigin))}">` +
    '<meta name="referrer" content="no-referrer">' + PAGE_PRELUDE
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  return doctype ? doctype[0] + head + html.slice(doctype[0].length) : head + html
}

/** Permissions a page never gets, whatever its server says. */
export const PAGE_FRAME_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; autoplay 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'"

/**
 * The wrapper around a published page: a script-free document whose only content is the page's
 * sandboxed frame. The wrapper's policy lets that frame load exactly `page` and nothing else, so a
 * page can't navigate itself (and the viewer's IP) off to another site.
 */
export function wrapperDocument(page: string | null): string {
  const policy = `default-src 'none'; frame-src ${page ? escapeAttribute(page) : "'none'"}; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`
  const frame = page
    ? `<iframe src="${escapeAttribute(page)}" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="${PAGE_FRAME_ALLOW}" title="Profile page"></iframe>`
    : ''
  return (
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;display:block;width:100%;height:100%}</style>' +
    `</head><body>${frame}</body></html>`
  )
}

/** Address of a published page, if it is a well-formed /pages/<id> path on that server. */
export function pageUrl(serverUrl: string, page: string | null | undefined): string | null {
  const origin = originOf(serverUrl)
  if (!origin || !page || !/^\/pages\/[A-Za-z0-9_-]{16,64}$/.test(page)) return null
  return origin + page
}

export const STARTER_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif;
         background: linear-gradient(135deg, #1b1b30, #3a2a6a); color: #f0eefe; }
  .card { text-align: center; padding: 32px; }
  h1 { margin: 0 0 8px; font-size: 2.4rem; }
  button { font: inherit; border: 0; border-radius: 99px; padding: 10px 20px; background: #7c6fff; color: #fff; cursor: pointer; }
  .sparks { font-size: 2rem; min-height: 2.5rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Hi, I'm new here</h1>
    <p>This is my corner of the server. Edit me in Settings, Profile page.</p>
    <div class="sparks" id="sparks"></div>
    <button id="spark">Make a spark</button>
  </div>
  <script>
    const sparks = ['✨', '⚡', '🔥', '🌟', '💜']
    document.getElementById('spark').onclick = () => {
      document.getElementById('sparks').textContent += sparks[Math.floor(Math.random() * sparks.length)]
    }
  </script>
</body>
</html>
`

// ── Device linking: the profile travels with the account ──

const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_AVATAR_BYTES = 1024 * 1024

/** The profile details a newly linked device receives (inside the sealed link payload). */
export interface LinkedProfile {
  bio?: string
  pronouns?: string
  accent?: string
  avatar?: { data: string; type: string } | null
  page?: { html: string } | null
}

export function profileForLink(profile: Profile | null | undefined): LinkedProfile {
  const out: LinkedProfile = authProfile(profile)
  if (profile?.avatar !== undefined) {
    out.avatar = profile.avatar && { data: sodium.to_base64(new Uint8Array(profile.avatar.bytes), sodium.base64_variants.URLSAFE_NO_PADDING), type: profile.avatar.type }
  }
  if (profile?.page !== undefined) out.page = profile.page && { html: profile.page.html }
  return out
}

/** Checks what another device sent; anything malformed is dropped, and hashes are recomputed here. */
export function profileFromLink(raw: unknown): Partial<Profile> {
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const out: Partial<Profile> = {}
  if (typeof r.bio === 'string' && r.bio.length <= MAX_BIO) out.bio = r.bio
  if (typeof r.pronouns === 'string' && r.pronouns.length <= MAX_PRONOUNS) out.pronouns = r.pronouns
  if (typeof r.accent === 'string' && (r.accent === '' || ACCENT_PATTERN.test(r.accent))) out.accent = r.accent
  if (r.avatar === null) out.avatar = null
  else if (typeof r.avatar === 'object') {
    const a = r.avatar as Record<string, unknown>
    try {
      const bytes = typeof a.data === 'string' ? sodium.from_base64(a.data, sodium.base64_variants.URLSAFE_NO_PADDING) : null
      if (bytes && bytes.length > 0 && bytes.length <= MAX_AVATAR_BYTES && typeof a.type === 'string' && AVATAR_TYPES.includes(a.type)) {
        out.avatar = { bytes: bytes.slice().buffer, type: a.type, hash: sha256Hex(bytes) }
      }
    } catch {
      /* not base64: dropped */
    }
  }
  if (r.page === null) out.page = null
  else if (typeof r.page === 'object') {
    const html = (r.page as Record<string, unknown>).html
    if (typeof html === 'string' && html.length > 0 && utf8Length(html) <= MAX_PAGE_BYTES) {
      out.page = { html, hash: sha256Hex(new TextEncoder().encode(html)) }
    }
  }
  return out
}
