import { describe, expect, it } from 'vitest'
import { fromB64, toB64, toB64u } from '../src/b64'
import { deviceId, openHandle, parseDevice, parseHandleKeys, sealHandle, type Device } from '../src/handle'
import { handle, MAX_BODY, type Env, type RateLimit, type Relay, type Sender } from '../src/index'
import { importEs256, signJwt } from '../src/jwt'
import { Apns, Fcm, parseServiceAccount, type PushMessage } from '../src/services'

const key = (n: number) => toB64(new Uint8Array(32).fill(n))
const IOS: Device = { platform: 'ios', token: 'ab'.repeat(32), voip: 'cd'.repeat(32) }
const ANDROID: Device = { platform: 'android', token: 'fcm-token_' + 'x'.repeat(140) }

async function pem(keyPair: CryptoKeyPair): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))
  return `-----BEGIN PRIVATE KEY-----\n${toB64(der).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`
}

const ecKeys = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
const rsaKeys = () =>
  crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>

async function verifyJwt(jwt: string, publicKey: CryptoKey) {
  const [h, c, s] = jwt.split('.')
  const algorithm = publicKey.algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }
  const ok = await crypto.subtle.verify(algorithm, publicKey, fromB64(s)! as BufferSource, new TextEncoder().encode(`${h}.${c}`))
  return { ok, header: JSON.parse(new TextDecoder().decode(fromB64(h)!)), claims: JSON.parse(new TextDecoder().decode(fromB64(c)!)) }
}

describe('base64', () => {
  it('round-trips both alphabets and rejects junk', () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255, 1])
    expect(fromB64(toB64(bytes))).toEqual(bytes)
    expect(fromB64(toB64u(bytes))).toEqual(bytes)
    expect(toB64u(bytes)).not.toMatch(/[+/=]/)
    expect(fromB64('a')).toBeNull()
    expect(fromB64('ab$c')).toBeNull()
  })
})

describe('handles', () => {
  it('seal and open a device, different every time', async () => {
    const keys = await parseHandleKeys(`1:${key(1)}`)
    const a = await sealHandle(keys, IOS)
    const b = await sealHandle(keys, IOS)
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await openHandle(keys, a)).toEqual(IOS)
    expect(await openHandle(keys, await sealHandle(keys, ANDROID))).toEqual(ANDROID)
    expect(await openHandle(keys, await sealHandle(keys, { platform: 'ios', token: 'ef'.repeat(32), sandbox: true }))).toEqual({
      platform: 'ios',
      token: 'ef'.repeat(32),
      sandbox: true,
    })
  })

  it('reject tampered, foreign and garbage handles', async () => {
    const keys = await parseHandleKeys(`1:${key(1)}`)
    const sealed = fromB64(await sealHandle(keys, ANDROID))!
    sealed[sealed.length - 1] ^= 1
    expect(await openHandle(keys, toB64u(sealed))).toBeNull()
    const other = await parseHandleKeys(`1:${key(2)}`)
    expect(await openHandle(other, await sealHandle(keys, ANDROID))).toBeNull()
    expect(await openHandle(keys, 'AAAA')).toBeNull()
    expect(await openHandle(keys, 'x'.repeat(2000))).toBeNull()
  })

  it('keep opening old handles after a key rotation', async () => {
    const old = await parseHandleKeys(`1:${key(1)}`)
    const handleText = await sealHandle(old, IOS)
    const rotated = await parseHandleKeys(`2:${key(2)}, 1:${key(1)}`)
    expect(rotated.current).toBe(2)
    expect(await openHandle(rotated, handleText)).toEqual(IOS)
    expect(await openHandle(await parseHandleKeys(`2:${key(2)}`), handleText)).toBeNull()
  })

  it('refuse malformed key lists', async () => {
    await expect(parseHandleKeys(undefined)).rejects.toThrow()
    await expect(parseHandleKeys('1:abc')).rejects.toThrow()
    await expect(parseHandleKeys(`300:${key(1)}`)).rejects.toThrow()
    await expect(parseHandleKeys(`1:${key(1)},1:${key(2)}`)).rejects.toThrow()
  })

  it('give a stable device id that is not the token', async () => {
    expect(await deviceId(IOS)).toBe(await deviceId({ ...IOS, voip: undefined }))
    expect(await deviceId(IOS)).not.toContain(IOS.token)
    expect(await deviceId(IOS)).not.toBe(await deviceId(ANDROID))
  })
})

describe('registrations', () => {
  it('accept real-looking tokens only', () => {
    expect(parseDevice({ platform: 'ios', token: 'AB'.repeat(32), voip: 'cd'.repeat(32), sandbox: true })).toEqual({
      platform: 'ios',
      token: 'ab'.repeat(32),
      voip: 'cd'.repeat(32),
      sandbox: true,
    })
    expect(parseDevice({ platform: 'android', token: ANDROID.token })).toEqual(ANDROID)
    expect(parseDevice({ platform: 'ios', token: 'zz'.repeat(32) })).toBeNull()
    expect(parseDevice({ platform: 'ios', token: 'ab' })).toBeNull()
    expect(parseDevice({ platform: 'ios', token: 'ab'.repeat(32), voip: 5 })).toBeNull()
    expect(parseDevice({ platform: 'android', token: 'short' })).toBeNull()
    expect(parseDevice({ platform: 'android', token: ANDROID.token, voip: 'cd'.repeat(32) })).toBeNull()
    expect(parseDevice({ platform: 'android', token: 'a b'.repeat(20) })).toBeNull()
    expect(parseDevice({ platform: 'web', token: 'x'.repeat(64) })).toBeNull()
    expect(parseDevice(null)).toBeNull()
  })
})

describe('JWTs', () => {
  it('sign ES256 tokens Apple can check', async () => {
    const pair = await ecKeys()
    const jwt = await signJwt(await importEs256(await pem(pair)), { alg: 'ES256', kid: 'K' }, { iss: 'T', iat: 1 })
    const { ok, header, claims } = await verifyJwt(jwt, pair.publicKey)
    expect(ok).toBe(true)
    expect(header).toEqual({ alg: 'ES256', kid: 'K' })
    expect(claims).toEqual({ iss: 'T', iat: 1 })
    expect(fromB64(jwt.split('.')[2])!.length).toBe(64) // raw r||s, as JWS wants
  })
})

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = []
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch ' + url)
    return typeof next === 'function' ? next() : next
  }
  return { calls, fetcher }
}

const NOTE: PushMessage = { kind: 'note', data: 'ZW5j', ttl: 60, collapse: 'topic1', urgent: true }

describe('APNs', () => {
  it('sends an alert for the Notification Service Extension to decrypt', async () => {
    const pair = await ecKeys()
    const { calls, fetcher } = fakeFetch([new Response(null, { status: 200 })])
    const apns = new Apns({ key: await pem(pair), keyId: 'KEY1', teamId: 'BWX2M8XSNZ', topic: 'foo.iskra.app' }, fetcher, () => 1_000_000_000_000)
    expect(await apns.send(IOS, NOTE)).toBe('ok')
    const [call] = calls
    expect(call.url).toBe(`https://api.push.apple.com/3/device/${IOS.token}`)
    const headers = call.init.headers as Record<string, string>
    expect(headers['apns-topic']).toBe('foo.iskra.app')
    expect(headers['apns-push-type']).toBe('alert')
    expect(headers['apns-priority']).toBe('10')
    expect(headers['apns-expiration']).toBe(String(1_000_000_000 + 60))
    expect(headers['apns-collapse-id']).toBe('topic1')
    const { ok, claims } = await verifyJwt(headers.authorization.replace('bearer ', ''), pair.publicKey)
    expect(ok).toBe(true)
    expect(claims.iss).toBe('BWX2M8XSNZ')
    const body = JSON.parse(call.init.body as string)
    expect(body.e).toBe('ZW5j')
    expect(body.aps['mutable-content']).toBe(1)
    expect(JSON.stringify(body)).not.toContain(IOS.token)
  })

  it('rings calls through PushKit when the app gave a VoIP token, in the sandbox for development builds', async () => {
    const { calls, fetcher } = fakeFetch([new Response(null, { status: 200 }), new Response(null, { status: 200 })])
    const apns = new Apns({ key: await pem(await ecKeys()), keyId: 'K', teamId: 'T', topic: 'foo.iskra.app' }, fetcher)
    const call: PushMessage = { kind: 'call', data: 'ZW5j', ttl: 30, collapse: 'c', urgent: true }
    expect(await apns.send({ ...IOS, sandbox: true }, call)).toBe('ok')
    expect(calls[0].url).toBe(`https://api.sandbox.push.apple.com/3/device/${IOS.voip}`)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['apns-topic']).toBe('foo.iskra.app.voip')
    expect(headers['apns-push-type']).toBe('voip')
    expect(headers['apns-collapse-id']).toBeUndefined()
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ e: 'ZW5j', k: 'call' })
    // Without a VoIP token a call is an ordinary alert.
    expect(await apns.send({ platform: 'ios', token: IOS.token }, call)).toBe('ok')
    expect((calls[1].init.headers as Record<string, string>)['apns-push-type']).toBe('alert')
  })

  it('reports dead tokens and renews an expired provider token once', async () => {
    const reason = (status: number, r: string) => () => new Response(JSON.stringify({ reason: r }), { status })
    const { calls, fetcher } = fakeFetch([
      reason(410, 'Unregistered'),
      reason(400, 'BadDeviceToken'),
      reason(403, 'ExpiredProviderToken'),
      new Response(null, { status: 200 }),
      reason(429, 'TooManyRequests'),
    ])
    const apns = new Apns({ key: await pem(await ecKeys()), keyId: 'K', teamId: 'T', topic: 'foo.iskra.app' }, fetcher)
    expect(await apns.send(IOS, NOTE)).toBe('gone')
    expect(await apns.send(IOS, NOTE)).toBe('gone')
    expect(await apns.send(IOS, NOTE)).toBe('ok')
    expect((calls[2].init.headers as Record<string, string>).authorization).not.toBe((calls[3].init.headers as Record<string, string>).authorization)
    expect(await apns.send(IOS, NOTE)).toBe('failed')
  })
})

describe('FCM', () => {
  async function account() {
    const pair = await rsaKeys()
    const json = JSON.stringify({ type: 'service_account', project_id: 'iskra-app', private_key_id: 'kid1', private_key: await pem(pair), client_email: 'relay@iskra-app.iam.gserviceaccount.com' })
    return { pair, config: parseServiceAccount(json) }
  }

  it('gets an access token with a signed assertion and sends a data message', async () => {
    const { pair, config } = await account()
    const { calls, fetcher } = fakeFetch([
      Response.json({ access_token: 'ya29.token', expires_in: 3599 }),
      Response.json({ name: 'projects/iskra-app/messages/1' }),
      Response.json({ name: 'projects/iskra-app/messages/2' }),
    ])
    const fcm = new Fcm(config, fetcher)
    expect(await fcm.send(ANDROID, NOTE)).toBe('ok')
    expect(await fcm.send(ANDROID, { ...NOTE, kind: 'call', urgent: false })).toBe('ok')
    expect(calls.length).toBe(3) // the access token is reused
    const assertion = new URLSearchParams(calls[0].init.body as string).get('assertion')!
    const { ok, header, claims } = await verifyJwt(assertion, pair.publicKey)
    expect(ok).toBe(true)
    expect(header.kid).toBe('kid1')
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging')
    expect(calls[1].url).toBe('https://fcm.googleapis.com/v1/projects/iskra-app/messages:send')
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer ya29.token')
    const message = JSON.parse(calls[1].init.body as string).message
    expect(message).toEqual({ token: ANDROID.token, data: { e: 'ZW5j', k: 'note' }, android: { priority: 'HIGH', ttl: '60s', collapse_key: 'topic1' } })
    const callMessage = JSON.parse(calls[2].init.body as string).message
    expect(callMessage.android.priority).toBe('HIGH')
    expect(callMessage.android.collapse_key).toBeUndefined()
  })

  it('reports unregistered tokens and retries once on 401', async () => {
    const { config } = await account()
    const error = (status: number, code: string) => () =>
      Response.json({ error: { status: code, details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] } }, { status })
    const { calls, fetcher } = fakeFetch([
      Response.json({ access_token: 'a', expires_in: 3600 }),
      error(404, 'UNREGISTERED'),
      error(401, 'UNAUTHENTICATED'),
      Response.json({ access_token: 'b', expires_in: 3600 }),
      Response.json({ name: 'ok' }),
      error(503, 'UNAVAILABLE'),
    ])
    const fcm = new Fcm(config, fetcher)
    expect(await fcm.send(ANDROID, NOTE)).toBe('gone')
    expect(await fcm.send(ANDROID, NOTE)).toBe('ok')
    expect((calls[4].init.headers as Record<string, string>).authorization).toBe('Bearer b')
    expect(await fcm.send(ANDROID, NOTE)).toBe('failed')
  })
})

describe('the worker', () => {
  class FakeSender implements Sender {
    sent: { device: Device; message: PushMessage }[] = []
    result: 'ok' | 'gone' | 'failed' = 'ok'
    async send(device: Device, message: PushMessage) {
      this.sent.push({ device, message })
      return this.result
    }
  }

  class Limit implements RateLimit {
    left: number
    keys: string[] = []
    constructor(left: number) {
      this.left = left
    }
    async limit({ key }: { key: string }) {
      this.keys.push(key)
      return { success: this.left-- > 0 }
    }
  }

  async function setup(env: Env = {}) {
    const apns = new FakeSender()
    const fcm = new FakeSender()
    const relay: Relay = { keys: await parseHandleKeys(`7:${key(7)}`), apns, fcm }
    const call = (path: string, init: RequestInit = {}) =>
      handle(new Request(`https://push.iskra.foo${path}`, { ...init, headers: { 'cf-connecting-ip': '203.0.113.5', ...(init.headers ?? {}) } }), env, relay)
    const register = async (device: unknown) => {
      const response = await call('/v1/register', { method: 'POST', body: JSON.stringify(device), headers: { 'content-type': 'application/json' } })
      return { response, endpoint: response.ok ? ((await response.json()) as { endpoint: string }).endpoint : '' }
    }
    return { apns, fcm, relay, call, register }
  }

  const pushInit = (body: Uint8Array, headers: Record<string, string> = {}): RequestInit => ({
    method: 'POST',
    body: body as BodyInit,
    headers: { 'content-encoding': 'aes128gcm', ttl: '60', topic: 'abc', urgency: 'high', authorization: 'vapid t=x, k=y', ...headers },
  })
  const encrypted = new Uint8Array(120).map((_, i) => i)

  it('registers a phone and forwards an encrypted push to it unchanged', async () => {
    const { apns, register, call } = await setup()
    const { response, endpoint } = await register({ platform: 'ios', token: IOS.token, voip: IOS.voip })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(endpoint).toMatch(/^https:\/\/push\.iskra\.foo\/v1\/push\/[A-Za-z0-9_-]+$/)
    expect(endpoint).not.toContain(IOS.token)

    const pushed = await call(new URL(endpoint).pathname, pushInit(encrypted))
    expect(pushed.status).toBe(201)
    expect(apns.sent).toHaveLength(1)
    expect(apns.sent[0].device).toEqual(IOS)
    expect(apns.sent[0].message).toEqual({ kind: 'note', data: toB64(encrypted), ttl: 60, collapse: 'abc', urgent: true })

    const rang = await call(new URL(endpoint).pathname.replace('/v1/push/', '/v1/call/'), pushInit(encrypted, { ttl: '30' }))
    expect(rang.status).toBe(201)
    expect(apns.sent[1].message.kind).toBe('call')
  })

  it('sends Android pushes through FCM', async () => {
    const { fcm, apns, register, call } = await setup()
    const { endpoint } = await register({ platform: 'android', token: ANDROID.token })
    expect((await call(new URL(endpoint).pathname, pushInit(encrypted, { urgency: 'normal' }))).status).toBe(201)
    expect(fcm.sent[0].device).toEqual(ANDROID)
    expect(fcm.sent[0].message.urgent).toBe(false)
    expect(apns.sent).toHaveLength(0)
  })

  it('answers CORS preflights and refuses bad registrations', async () => {
    const { call, register } = await setup()
    const preflight = await call('/v1/register', { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type')
    expect((await register({ platform: 'ios', token: 'nope' })).response.status).toBe(400)
    expect((await call('/v1/register', { method: 'POST', body: '{' })).status).toBe(400)
    expect((await call('/v1/register', { method: 'POST', body: 'x'.repeat(5000) })).status).toBe(400)
    expect((await call('/v1/register')).status).toBe(405)
  })

  it('says when a platform is not configured', async () => {
    const { relay, register } = await setup()
    relay.fcm = null
    expect((await register({ platform: 'android', token: ANDROID.token })).response.status).toBe(503)
  })

  it('tells servers to forget unknown and dead handles (404/410)', async () => {
    const { apns, register, call } = await setup()
    expect((await call('/v1/push/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', pushInit(encrypted))).status).toBe(404)
    const { endpoint } = await register({ platform: 'ios', token: IOS.token })
    apns.result = 'gone'
    expect((await call(new URL(endpoint).pathname, pushInit(encrypted))).status).toBe(410)
    apns.result = 'failed'
    expect((await call(new URL(endpoint).pathname, pushInit(encrypted))).status).toBe(502)
  })

  it('checks Web Push headers and body size', async () => {
    const { apns, register, call } = await setup()
    const path = new URL((await register({ platform: 'ios', token: IOS.token })).endpoint).pathname
    expect((await call(path, pushInit(encrypted, { 'content-encoding': 'aesgcm' }))).status).toBe(415)
    expect((await call(path, pushInit(encrypted, { ttl: 'soon' }))).status).toBe(400)
    expect((await call(path, pushInit(new Uint8Array(MAX_BODY + 1)))).status).toBe(413)
    expect((await call(path, pushInit(new Uint8Array(20)))).status).toBe(400)
    expect((await call(path, { method: 'GET' })).status).toBe(405)
    expect((await call('/v1/elsewhere')).status).toBe(404)
    const capped = await call(path, pushInit(encrypted, { ttl: '999999999', topic: 'not a topic!' }))
    expect(capped.status).toBe(201)
    expect(apns.sent.at(-1)!.message.ttl).toBe(28 * 24 * 3600)
    expect(apns.sent.at(-1)!.message.collapse).toBeUndefined()
  })

  it('rate limits registrations per IP and pushes per device and sender', async () => {
    const env: Env = { REGISTER_LIMIT: new Limit(1), SEND_IP_LIMIT: new Limit(100), DEVICE_LIMIT: new Limit(1) }
    const { register, call } = await setup(env)
    const { endpoint } = await register({ platform: 'ios', token: IOS.token })
    const second = await register({ platform: 'ios', token: IOS.token })
    expect(second.response.status).toBe(429)
    expect((env.REGISTER_LIMIT as Limit).keys).toEqual(['203.0.113.5', '203.0.113.5'])
    const path = new URL(endpoint).pathname
    expect((await call(path, pushInit(encrypted))).status).toBe(201)
    const limited = await call(path, pushInit(encrypted))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect((env.DEVICE_LIMIT as Limit).keys[0]).toBe(await deviceId({ platform: 'ios', token: IOS.token }))
    const sender = new Limit(0)
    expect((await (await setup({ SEND_IP_LIMIT: sender })).call(path, pushInit(encrypted))).status).toBe(429)
  })

  it('reports health without secrets', async () => {
    const { call } = await setup()
    expect(await (await call('/v1/health')).json()).toEqual({ ok: true, apns: true, fcm: true })
  })
})
