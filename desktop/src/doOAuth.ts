// "Connect to DigitalOcean": OAuth for a desktop (public) client, the way DigitalOcean asks for it: authorization code
// with PKCE (S256), the browser sent back to a one-shot listener on 127.0.0.1 (DigitalOcean matches loopback redirect
// URIs only on the registered port: OAUTH_PORT). The code is exchanged here for a short-lived token (an hour), which goes straight to DoRental and
// is never logged or written down. No Electron imports, so the unit tests run in plain Node.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DoError } from './digitalocean'

/**
 * The public OAuth client id of Iskra's DigitalOcean app (a public client: no secret; callback
 * http://127.0.0.1:47099/callback, see OAUTH_PORT). Without a valid one the app offers only the pasted token.
 */
export const DO_OAUTH_CLIENT_ID = '6f464bf39c0257c14395112093a53cbd6f6beef1ad568135b41a8f9c44090135'
export const DO_AUTHORIZE = 'https://cloud.digitalocean.com/v1/oauth/authorize'
export const DO_TOKEN = 'https://cloud.digitalocean.com/v1/oauth/token'
/** The least that works: the same scopes the token steps ask for. */
export const DO_OAUTH_SCOPES = [
  'droplet:create', 'droplet:read', 'droplet:delete',
  'firewall:create', 'firewall:read', 'firewall:delete',
  'regions:read', 'sizes:read', 'tag:create',
] as const
/** How long the browser has to come back. */
export const OAUTH_TIMEOUT_MS = 10 * 60_000
/**
 * DigitalOcean matches the registered callback exactly, port included (despite its docs on loopback ports), so the
 * listener uses this one port; the OAuth app's Callback URL is http://127.0.0.1:47099/callback. If something else
 * holds the port, the dialog falls back to a pasted token.
 */
export const OAUTH_PORT = 47099

export const oauthConfigured = (clientId: string): boolean => /^[A-Za-z0-9_-]{16,128}$/.test(clientId)

const b64u = (bytes: Buffer) => bytes.toString('base64url')

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(randomBytes(32))
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(o: { base?: string; clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: DO_OAUTH_SCOPES.join(' '),
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
  })
  return `${o.base ?? DO_AUTHORIZE}?${q}`
}

export interface CallbackPages {
  /** Shown in the browser once the app has the code (or the user said no). Plain text only. */
  done: string
  denied: string
}

export interface Loopback {
  redirectUri: string
  /** The authorization code, once the browser comes back with the right state. */
  code: Promise<string>
  close(): void
}

const page = (text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Iskra</title>` +
  `<body style="font:16px system-ui,sans-serif;margin:3em auto;max-width:30em;padding:0 1em">` +
  `<p>${text.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' } as Record<string, string>)[c]};`)}</p>`

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * A one-shot HTTP listener on 127.0.0.1 only (a random port): GET /callback?code=…&state=… with our state ends it.
 * Anything else (another path, another Host, a wrong state) gets an error and doesn't count. Closes after the first
 * good answer, on timeout, or when the signal fires.
 */
export async function loopbackCallback(state: string, pages: CallbackPages, options: { timeoutMs?: number; signal?: AbortSignal; port?: number } = {}): Promise<Loopback> {
  const { timeoutMs = OAUTH_TIMEOUT_MS, signal, port: wanted = 0 } = options
  let settle: { resolve: (code: string) => void; reject: (e: Error) => void } | null = null
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }))
  code.catch(() => undefined) // whoever awaits it sees the error; an unawaited one isn't a crash
  let port = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, text: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      res.end(page(text))
    }
    // Only a browser on this computer that came to this exact address (no DNS rebinding).
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}`) return reply(400, 'Bad request')
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== '/callback') return reply(404, 'Not found')
    const given = url.searchParams.get('state') ?? ''
    if (!same(given, state)) return reply(400, 'Bad request')
    const got = url.searchParams.get('code')
    const ok = !!got && /^[\w.~-]{1,512}$/.test(got)
    reply(200, ok ? pages.done : pages.denied)
    finish(ok ? null : new DoError('denied', (url.searchParams.get('error') ?? '').slice(0, 60)), got ?? '')
  })
  const timer = setTimeout(() => finish(new DoError('timeout', 'oauth')), timeoutMs)
  const onAbort = () => finish(new DoError('cancelled'))
  function finish(error: Error | null, value = '') {
    if (!settle) return
    const s = settle
    settle = null
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections()
    if (error) s.reject(error)
    else s.resolve(value)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(wanted, '127.0.0.1', () => resolve())
    })
  } catch (e) {
    clearTimeout(timer)
    settle = null
    throw (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? new DoError('unavailable', 'port') : e
  }
  port = (server.address() as AddressInfo).port
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort)
  return { redirectUri: `http://127.0.0.1:${port}/callback`, code, close: () => finish(new DoError('cancelled')) }
}

/** The code for a token, with the PKCE verifier (no client secret: a desktop app can't keep one). */
export async function exchangeCode(o: { tokenUrl?: string; clientId: string; code: string; redirectUri: string; verifier: string; fetch?: typeof fetch }): Promise<string> {
  let response: Response
  try {
    response = await (o.fetch ?? fetch)(o.tokenUrl ?? DO_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: o.code, client_id: o.clientId, redirect_uri: o.redirectUri, code_verifier: o.verifier }).toString(),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
  } catch {
    throw new DoError('network')
  }
  const json = (await response.json().catch(() => null)) as { access_token?: unknown; error_description?: unknown } | null
  if (!response.ok || typeof json?.access_token !== 'string') {
    throw new DoError(response.status >= 500 ? 'server' : 'token', typeof json?.error_description === 'string' ? json.error_description.slice(0, 200) : '')
  }
  return json.access_token
}

/** The whole dance: listen, open the browser, wait for the code, swap it for a token. */
export async function oauthToken(o: {
  clientId: string
  pages: CallbackPages
  open: (url: string) => Promise<unknown>
  authorizeBase?: string
  tokenUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  /** The loopback port (OAUTH_PORT; tests pass 0 for any free port). */
  port?: number
}): Promise<string> {
  if (!oauthConfigured(o.clientId)) throw new DoError('unavailable')
  const state = b64u(randomBytes(24))
  const { verifier, challenge } = pkce()
  const loop = await loopbackCallback(state, o.pages, { timeoutMs: o.timeoutMs, signal: o.signal, port: o.port ?? OAUTH_PORT })
  try {
    await o.open(authorizeUrl({ base: o.authorizeBase, clientId: o.clientId, redirectUri: loop.redirectUri, state, challenge }))
    const code = await loop.code
    return await exchangeCode({ tokenUrl: o.tokenUrl, clientId: o.clientId, code, redirectUri: loop.redirectUri, verifier, fetch: o.fetch })
  } finally {
    loop.close()
  }
}

/** Tests only (never in a packaged app): a client id, and a fake authorize and token endpoint on loopback. */
export function oauthTestOverrides(env: NodeJS.ProcessEnv, packaged: boolean): { clientId?: string; authorizeBase?: string; tokenUrl?: string } {
  if (packaged || env.ISKRA_E2E !== '1') return {}
  const api = env.ISKRA_DO_API && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(env.ISKRA_DO_API) ? env.ISKRA_DO_API : null
  const clientId = env.ISKRA_DO_OAUTH_CLIENT_ID && oauthConfigured(env.ISKRA_DO_OAUTH_CLIENT_ID) ? env.ISKRA_DO_OAUTH_CLIENT_ID : undefined
  return api ? { clientId, authorizeBase: `${api}/v1/oauth/authorize`, tokenUrl: `${api}/v1/oauth/token` } : {}
}
