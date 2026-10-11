// Passkeys for the app lock (client/src/platform/passkeys.ts). The app page lives on app://iskra, where Chromium
// refuses WebAuthn, so the main process runs each ceremony in a small window of its own, on https://app.iskra.foo
// served from memory (an in-memory session that only ever answers with this one page). Passkeys made here belong
// to app.iskra.foo, like the web app's. Requests and results are plain JSON, checked here before anything runs.

export const PASSKEY_ORIGIN = 'https://app.iskra.foo'
export const PASSKEY_PAGE = `${PASSKEY_ORIGIN}/passkey`
const RP_ID = 'app.iskra.foo'

export interface CreateRequest {
  rpId: string
  userId: string
  userName: string
  displayName: string
  challenge: string
  exclude: string[]
  prfSalt: string
}

export interface GetRequest {
  rpId: string
  challenge: string
  salts: Record<string, string>
}

const b64u = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value)
const plain = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

export function parseCreate(raw: unknown): CreateRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.rpId !== RP_ID || !b64u(r.userId, 128) || !plain(r.userName, 128) || !plain(r.displayName, 128)) return null
  if (!b64u(r.challenge, 128) || !b64u(r.prfSalt, 128)) return null
  if (!Array.isArray(r.exclude) || r.exclude.length > 20 || !r.exclude.every((id) => b64u(id))) return null
  return { rpId: RP_ID, userId: r.userId, userName: r.userName, displayName: r.displayName, challenge: r.challenge, exclude: r.exclude as string[], prfSalt: r.prfSalt }
}

export function parseGet(raw: unknown): GetRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.rpId !== RP_ID || !b64u(r.challenge, 128) || !r.salts || typeof r.salts !== 'object') return null
  const salts = Object.entries(r.salts as Record<string, unknown>)
  if (salts.length === 0 || salts.length > 20 || !salts.every(([id, salt]) => b64u(id) && b64u(salt, 128))) return null
  return { rpId: RP_ID, challenge: r.challenge, salts: Object.fromEntries(salts) as Record<string, string> }
}

/** The ceremony as page script. The request is embedded as JSON (already checked), never as code. */
export function ceremonyScript(op: 'create' | 'get', request: CreateRequest | GetRequest): string {
  return `(async (op, r) => {
  const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0))
  const text = (b) => btoa(String.fromCharCode(...new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  try {
    if (op === 'create') {
      const c = await navigator.credentials.create({ publicKey: {
        rp: { id: r.rpId, name: 'Iskra' },
        user: { id: bytes(r.userId), name: r.userName, displayName: r.displayName },
        challenge: bytes(r.challenge),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        excludeCredentials: r.exclude.map((id) => ({ type: 'public-key', id: bytes(id) })),
        attestation: 'none',
        extensions: { prf: { eval: { first: bytes(r.prfSalt) } } } } })
      const prf = c.getClientExtensionResults().prf || {}
      const first = prf.results && prf.results.first
      return { ok: true, id: text(c.rawId), prfEnabled: !!prf.enabled || !!first, prfFirst: first ? text(first) : undefined }
    }
    const ids = Object.keys(r.salts)
    const c = await navigator.credentials.get({ publicKey: {
      rpId: r.rpId, challenge: bytes(r.challenge), userVerification: 'required',
      allowCredentials: ids.map((id) => ({ type: 'public-key', id: bytes(id) })),
      extensions: { prf: { evalByCredential: Object.fromEntries(ids.map((id) => [id, { first: bytes(r.salts[id]) }])) } } } })
    const prf = c.getClientExtensionResults().prf || {}
    const first = prf.results && prf.results.first
    return { ok: true, id: text(c.rawId), prfFirst: first ? text(first) : undefined }
  } catch (e) {
    return { ok: false, name: String(e && e.name || 'Error'), message: String(e && e.message || '') }
  }
})(${JSON.stringify(op)}, ${JSON.stringify(request)})`
}

/** The page the ceremony window shows. Static text only. */
export function passkeyPage(title: string, waiting: string): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0b14;color:#e8e8f0;font:15px system-ui,sans-serif;text-align:center;padding:0 24px;box-sizing:border-box}</style>
</head><body><p>${escape(waiting)}</p></body></html>`
}
