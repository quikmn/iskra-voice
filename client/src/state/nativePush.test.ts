import { describe, expect, it } from 'vitest'
import type { NativePushRegistration } from '../platform/native'
import { handleCacheKey, RelayError, relayEndpoint, RELAY_URL, syncNativeServer } from './nativePush'

const IOS: NativePushRegistration = { platform: 'ios', token: 'ab'.repeat(32), voip: 'cd'.repeat(32), p256dh: 'P', auth: 'A' }
const ANDROID: NativePushRegistration = { platform: 'android', token: 'fcm-token', p256dh: 'P', auth: 'A' }
const SERVER_A = 'B'.repeat(87)
const SERVER_B = 'C'.repeat(87)

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

function relay(answers: (() => Response)[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  let n = 0
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) })
    const answer = answers[n++]
    if (!answer) throw new TypeError('Failed to fetch')
    return answer()
  }
  return { calls, fetch }
}

const endpoint = (h: string) => () => Response.json({ endpoint: `${RELAY_URL}/v1/push/${h}` })

describe('relay registration', () => {
  it('registers once per token set and server, then uses the cache', async () => {
    const storage = memoryStorage()
    const { calls, fetch } = relay([endpoint('h1'), endpoint('h2'), endpoint('h3')])
    expect(await relayEndpoint(IOS, SERVER_A, { fetch, storage })).toBe(`${RELAY_URL}/v1/push/h1`)
    expect(await relayEndpoint(IOS, SERVER_A, { fetch, storage })).toBe(`${RELAY_URL}/v1/push/h1`)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${RELAY_URL}/v1/register`)
    expect(calls[0].body).toEqual({ platform: 'ios', token: IOS.token, voip: IOS.voip, vapidKey: SERVER_A })
    // The private parts never go to the relay.
    expect(JSON.stringify(calls[0].body)).not.toContain('"auth"')

    // Another server gets its own handle; a new token needs a new one too.
    expect(await relayEndpoint(IOS, SERVER_B, { fetch, storage })).toBe(`${RELAY_URL}/v1/push/h2`)
    expect(await relayEndpoint({ ...IOS, token: 'ef'.repeat(32) }, SERVER_A, { fetch, storage })).toBe(`${RELAY_URL}/v1/push/h3`)
    expect(calls).toHaveLength(3)
  })

  it('keys the cache on everything the handle holds', () => {
    expect(handleCacheKey(IOS, SERVER_A)).not.toBe(handleCacheKey({ ...IOS, sandbox: true }, SERVER_A))
    expect(handleCacheKey(IOS, SERVER_A)).not.toBe(handleCacheKey({ ...IOS, voip: undefined }, SERVER_A))
    expect(handleCacheKey(ANDROID, SERVER_A)).not.toBe(handleCacheKey(ANDROID, SERVER_B))
  })

  it('reports relay errors and refuses endpoints elsewhere', async () => {
    const storage = memoryStorage()
    const refused = relay([() => Response.json({ error: 'Too many registrations.' }, { status: 429 })])
    await expect(relayEndpoint(ANDROID, SERVER_A, { ...refused, storage })).rejects.toThrow(new RelayError('Too many registrations.'))
    const offline = relay([])
    await expect(relayEndpoint(ANDROID, SERVER_A, { ...offline, storage })).rejects.toBeInstanceOf(RelayError)
    const elsewhere = relay([() => Response.json({ endpoint: 'https://evil.example/v1/push/x' })])
    await expect(relayEndpoint(ANDROID, SERVER_A, { ...elsewhere, storage })).rejects.toBeInstanceOf(RelayError)
    expect(storage.data.size).toBe(0)
  })

  it('survives broken or missing storage', async () => {
    const broken = { getItem: () => '{not json', setItem: () => { throw new Error('full') } }
    const { fetch } = relay([endpoint('x')])
    expect(await relayEndpoint(ANDROID, SERVER_A, { fetch, storage: broken })).toBe(`${RELAY_URL}/v1/push/x`)
    expect(await relayEndpoint(ANDROID, SERVER_A, { fetch: relay([endpoint('y')]).fetch, storage: null })).toBe(`${RELAY_URL}/v1/push/y`)
  })
})

describe('subscribing a server', () => {
  function fakeConnection(status: { publicKey: string; endpoint: string | null }) {
    const sent: { type: string; body: unknown }[] = []
    return {
      sent,
      request: (async (type: string, body: unknown) => {
        sent.push({ type, body })
        return type === 'push.status' ? status : {}
      }) as never,
    }
  }

  it('gives the server a native subscription with the app keys', async () => {
    const connection = fakeConnection({ publicKey: SERVER_A, endpoint: null })
    await syncNativeServer(connection, IOS, { fetch: relay([endpoint('h1')]).fetch, storage: memoryStorage() })
    expect(connection.sent[1]).toEqual({
      type: 'push.subscribe',
      body: { kind: 'native', endpoint: `${RELAY_URL}/v1/push/h1`, keys: { p256dh: 'P', auth: 'A' } },
    })
  })

  it('does nothing when the server already has it', async () => {
    const storage = memoryStorage()
    await relayEndpoint(IOS, SERVER_A, { fetch: relay([endpoint('h1')]).fetch, storage })
    const connection = fakeConnection({ publicKey: SERVER_A, endpoint: `${RELAY_URL}/v1/push/h1` })
    await syncNativeServer(connection, IOS, { fetch: relay([]).fetch, storage })
    expect(connection.sent.map((s) => s.type)).toEqual(['push.status'])
  })
})
