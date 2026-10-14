import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { test } from 'node:test'
import type { DoError } from './digitalocean'
import { authorizeUrl, DO_OAUTH_CLIENT_ID, exchangeCode, loopbackCallback, oauthConfigured, oauthTestOverrides, oauthToken, pkce } from './doOAuth'

const PAGES = { done: 'Connected <ok>', denied: 'Not connected' }
const STATE = 'state-' + 'x'.repeat(30)

/** A GET with a chosen Host header (fetch won't let us set it). */
function get(url: string, host?: string): Promise<{ status: number; body: string; csp: string }> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: host ? { Host: host } : {} }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, csp: String(res.headers['content-security-policy'] ?? '') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test("Iskra's client id is set; without a valid one the app offers only the pasted token", () => {
  assert.equal(oauthConfigured(DO_OAUTH_CLIENT_ID), true)
  assert.equal(oauthConfigured(''), false)
  assert.equal(oauthConfigured('abc'), false)
  assert.equal(oauthConfigured('a'.repeat(64)), true)
})

test('the authorize link: code flow with PKCE (S256), our state, the least scopes, a loopback callback', () => {
  const { verifier, challenge } = pkce()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  const url = new URL(authorizeUrl({ clientId: 'client', redirectUri: 'http://127.0.0.1:5000/callback', state: STATE, challenge }))
  assert.equal(url.origin + url.pathname, 'https://cloud.digitalocean.com/v1/oauth/authorize')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: 'client', redirect_uri: 'http://127.0.0.1:5000/callback', response_type: 'code', state: STATE, code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'droplet:create droplet:read droplet:delete firewall:create firewall:read firewall:delete regions:read sizes:read tag:create',
  })
})

test('the listener: loopback only, wrong state and wrong host rejected, closes after one good answer', async () => {
  const loop = await loopbackCallback(STATE, PAGES)
  const redirect = new URL(loop.redirectUri)
  assert.equal(redirect.hostname, '127.0.0.1')
  assert.equal(redirect.pathname, '/callback')
  const base = `http://127.0.0.1:${redirect.port}`

  assert.equal((await get(`${base}/callback?code=evil&state=wrong`)).status, 400)
  assert.equal((await get(`${base}/callback?code=evil&state=${STATE}`, `attacker.example:${redirect.port}`)).status, 400)
  assert.equal((await get(`${base}/other?code=evil&state=${STATE}`)).status, 404)
  // Not on other addresses of this computer.
  await assert.rejects(get(`http://[::1]:${redirect.port}/callback?code=x&state=${STATE}`))

  const good = await get(`${base}/callback?code=the-code.123&state=${STATE}`)
  assert.equal(good.status, 200)
  assert.equal(good.csp, "default-src 'none'")
  assert.match(good.body, /Connected &lt;ok&gt;/)
  assert.equal(await loop.code, 'the-code.123')
  await assert.rejects(get(`${base}/callback?code=again&state=${STATE}`)) // closed
})

test('the user saying no ends it', async () => {
  const loop = await loopbackCallback(STATE, PAGES)
  const res = await get(`${loop.redirectUri}?error=access_denied&state=${STATE}`)
  assert.match(res.body, /Not connected/)
  await assert.rejects(loop.code, (e: DoError) => e.code === 'denied' && e.detail === 'access_denied')
})

test('it gives up after the timeout, and on cancel, and closes', async () => {
  const loop = await loopbackCallback(STATE, PAGES, { timeoutMs: 20 })
  await assert.rejects(loop.code, (e: DoError) => e.code === 'timeout')
  await assert.rejects(get(`${loop.redirectUri}?code=x&state=${STATE}`))
  const abort = new AbortController()
  const other = await loopbackCallback(STATE, PAGES, { signal: abort.signal })
  abort.abort()
  await assert.rejects(other.code, (e: DoError) => e.code === 'cancelled')
})

test('the code is exchanged with the verifier and no secret; errors become codes', async () => {
  const seen: { url: string; body: string }[] = []
  const ok = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body) })
    return new Response(JSON.stringify({ access_token: 'doo_v1_' + 'b'.repeat(64), expires_in: 3600 }), { status: 200 })
  }) as typeof fetch
  const token = await exchangeCode({ clientId: 'client', code: 'c', redirectUri: 'http://127.0.0.1:1/callback', verifier: 'v', fetch: ok })
  assert.equal(token, 'doo_v1_' + 'b'.repeat(64))
  assert.equal(seen[0].url, 'https://cloud.digitalocean.com/v1/oauth/token')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[0].body)), {
    grant_type: 'authorization_code', code: 'c', client_id: 'client', redirect_uri: 'http://127.0.0.1:1/callback', code_verifier: 'v',
  })
  const bad = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 400 })) as unknown as typeof fetch
  await assert.rejects(exchangeCode({ clientId: 'c', code: 'c', redirectUri: 'r', verifier: 'v', fetch: bad }), (e: DoError) => e.code === 'token' && e.detail === 'expired')
  const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  await assert.rejects(exchangeCode({ clientId: 'c', code: 'c', redirectUri: 'r', verifier: 'v', fetch: down }), (e: DoError) => e.code === 'network')
})

test('the whole dance: open the browser, the browser comes back, a token', async () => {
  const clientId = 'c'.repeat(32)
  const token = await oauthToken({
    clientId,
    pages: PAGES,
    // The "browser": DigitalOcean sends it straight back with a code and the same state.
    open: async (url) => {
      const q = new URL(url).searchParams
      assert.equal(q.get('client_id'), clientId)
      assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:47099/callback') // the registered Callback URL, port included
      await get(`${q.get('redirect_uri')}?code=abc&state=${encodeURIComponent(q.get('state')!)}`)
    },
    fetch: (async (_u: string | URL, init?: RequestInit) => {
      assert.equal(new URLSearchParams(String(init?.body)).get('code'), 'abc')
      return new Response(JSON.stringify({ access_token: 'doo_v1_tok' }), { status: 200 })
    }) as typeof fetch,
  })
  assert.equal(token, 'doo_v1_tok')
  await assert.rejects(oauthToken({ clientId: '', pages: PAGES, open: async () => undefined }), (e: DoError) => e.code === 'unavailable')
})

test('test endpoints only in tests, on loopback, never packaged', () => {
  const env = { ISKRA_E2E: '1', ISKRA_DO_API: 'http://127.0.0.1:5191', ISKRA_DO_OAUTH_CLIENT_ID: 'e'.repeat(32) }
  assert.deepEqual(oauthTestOverrides(env, false), {
    clientId: 'e'.repeat(32), authorizeBase: 'http://127.0.0.1:5191/v1/oauth/authorize', tokenUrl: 'http://127.0.0.1:5191/v1/oauth/token',
  })
  assert.deepEqual(oauthTestOverrides(env, true), {})
  assert.deepEqual(oauthTestOverrides({ ...env, ISKRA_E2E: '0' }, false), {})
  assert.deepEqual(oauthTestOverrides({ ...env, ISKRA_DO_API: 'https://evil.example' }, false), {})
})

test('a busy callback port falls back to the pasted token (unavailable)', async () => {
  const { createServer } = await import('node:http')
  const squatter = createServer()
  await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', () => r()))
  const port = (squatter.address() as import('node:net').AddressInfo).port
  try {
    await assert.rejects(loopbackCallback(STATE, PAGES, { port }), (e: DoError) => e.code === 'unavailable' && e.detail === 'port')
  } finally {
    squatter.close()
  }
})
