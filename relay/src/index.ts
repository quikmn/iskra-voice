// The Iskra push relay (Cloudflare Worker, https://push.iskra.foo). Iskra servers are self-hosted and can't hold
// Apple's or Google's push credentials, so the phone apps register their push token here and get back a Web Push
// endpoint with a sealed handle in it. Servers push to that endpoint like to any browser (RFC 8030/8291, body
// encrypted to the phone); the relay opens the handle and hands the still-encrypted body to APNs or FCM.
//
//   POST /v1/register              { platform, token, voip?, sandbox? } → { endpoint }      (the app)
//   POST /v1/push/<handle>         Web Push: TTL, Topic, Urgency headers, aes128gcm body       (servers)
//   POST /v1/call/<handle>         the same, for a ringing call
//   GET  /v1/health                { ok, apns, fcm }
//
// No storage, no logs of tokens or bodies. Abuse limits: per IP for registrations and sends, per device for sends,
// bodies ≤ 3 KB, only handles this relay sealed.
import { toB64 } from './b64'
import { deviceId, openHandle, parseDevice, parseHandleKeys, sealHandle, type Device, type HandleKeys } from './handle'
import { Apns, Fcm, parseServiceAccount, type PushMessage, type SendResult } from './services'

/** Cloudflare's rate limiting binding (wrangler.toml [[ratelimits]]). */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  HANDLE_KEYS?: string
  APNS_KEY?: string
  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_TOPIC?: string
  FCM_SERVICE_ACCOUNT?: string
  REGISTER_LIMIT?: RateLimit
  SEND_IP_LIMIT?: RateLimit
  DEVICE_LIMIT?: RateLimit
}

export interface Sender {
  send(device: Device, message: PushMessage): Promise<SendResult>
}

export interface Relay {
  keys: HandleKeys
  apns: Sender | null
  fcm: Sender | null
}

/** The largest push body accepted. Server payloads are well under 1 KB; base64 must fit FCM's and APNs's 4 KB. */
export const MAX_BODY = 3072
const MAX_TTL = 28 * 24 * 3600

let cached: { env: Env; relay: Promise<Relay> } | null = null

export function relayFrom(env: Env): Promise<Relay> {
  if (cached?.env === env) return cached.relay
  const relay = (async () => ({
    keys: await parseHandleKeys(env.HANDLE_KEYS),
    apns: env.APNS_KEY && env.APNS_KEY_ID
      ? new Apns({ key: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID ?? '', topic: env.APNS_TOPIC ?? 'foo.iskra.app' })
      : null,
    fcm: env.FCM_SERVICE_ACCOUNT ? new Fcm(parseServiceAccount(env.FCM_SERVICE_ACCOUNT)) : null,
  }))()
  cached = { env, relay }
  return relay
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } })
}

function problem(status: number, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { error: message }, extra)
}

async function allowed(limit: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limit) return true
  try {
    return (await limit.limit({ key })).success
  } catch {
    return true // the limiter being down shouldn't stop pushes
  }
}

export async function handle(request: Request, env: Env, relay?: Relay): Promise<Response> {
  const url = new URL(request.url)
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'

  if (url.pathname === '/v1/health' && request.method === 'GET') {
    const r = relay ?? (await relayFrom(env))
    return json(200, { ok: true, apns: r.apns !== null, fcm: r.fcm !== null })
  }

  if (url.pathname === '/v1/register') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (request.method !== 'POST') return problem(405, 'Use POST.', CORS)
    if (!(await allowed(env.REGISTER_LIMIT, ip))) return problem(429, 'Too many registrations. Try again in a minute.', { ...CORS, 'retry-after': '60' })
    const text = await readText(request, 4096)
    let body: unknown
    try {
      body = text === null ? null : JSON.parse(text)
    } catch {
      body = null
    }
    const device = parseDevice(body)
    if (!device) return problem(400, 'That isn\'t a push registration.', CORS)
    const r = relay ?? (await relayFrom(env))
    if ((device.platform === 'ios' ? r.apns : r.fcm) === null) return problem(503, 'Push for this platform isn\'t set up on the relay yet.', CORS)
    const handleText = await sealHandle(r.keys, device)
    return json(200, { endpoint: `${url.origin}/v1/push/${handleText}` }, CORS)
  }

  const route = /^\/v1\/(push|call)\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
  if (!route) return problem(404, 'Not found.')
  if (request.method !== 'POST') return problem(405, 'Use POST.')
  if (!(await allowed(env.SEND_IP_LIMIT, ip))) return problem(429, 'Too many pushes from this address.', { 'retry-after': '60' })

  const r = relay ?? (await relayFrom(env))
  const device = await openHandle(r.keys, route[2])
  // Web Push semantics: 404/410 tell the server to forget this subscription.
  if (!device) return problem(404, 'Unknown push handle.')
  if (!(await allowed(env.DEVICE_LIMIT, await deviceId(device)))) return problem(429, 'Too many pushes to this device.', { 'retry-after': '60' })

  if ((request.headers.get('content-encoding') ?? '').toLowerCase() !== 'aes128gcm') return problem(415, 'Bodies must be aes128gcm (RFC 8291).')
  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > MAX_BODY) return problem(413, `Push bodies are limited to ${MAX_BODY} bytes.`)
  const body = await readBytes(request, MAX_BODY)
  if (body === null) return problem(413, `Push bodies are limited to ${MAX_BODY} bytes.`)
  if (body.length < 86) return problem(400, 'That isn\'t an encrypted push.') // header (86 bytes with a P-256 key) + tag

  const ttlHeader = request.headers.get('ttl')
  const ttl = ttlHeader !== null && /^\d{1,10}$/.test(ttlHeader) ? Math.min(Number(ttlHeader), MAX_TTL) : null
  if (ttl === null) return problem(400, 'The TTL header is required.')
  const topic = request.headers.get('topic')
  const message: PushMessage = {
    kind: route[1] === 'call' ? 'call' : 'note',
    data: toB64(body),
    ttl,
    collapse: topic && /^[A-Za-z0-9_-]{1,32}$/.test(topic) ? topic : undefined,
    urgent: (request.headers.get('urgency') ?? 'normal').toLowerCase() === 'high',
  }

  const sender = device.platform === 'ios' ? r.apns : r.fcm
  if (!sender) return problem(503, 'Push for this platform isn\'t set up on the relay.')
  let result: SendResult
  try {
    result = await sender.send(device, message)
  } catch {
    result = 'failed'
  }
  if (result === 'ok') return new Response(null, { status: 201 })
  if (result === 'gone') return problem(410, 'This device no longer takes pushes.')
  return problem(502, 'The push service didn\'t take it. Try again later.')
}

/** The body, or null if it's longer than max bytes. */
async function readBytes(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function readText(request: Request, max: number): Promise<string | null> {
  const bytes = await readBytes(request, max)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env)
    } catch {
      return problem(500, 'The relay had a problem.')
    }
  },
}
