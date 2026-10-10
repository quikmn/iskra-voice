import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, generateSigningKeyPair, ready, sign, signedPayload, u64be } from './crypto'
import { cleanServerUrl, MOVE_CONTEXT, probeServerKey, sameServerUrl, verifyMoveNotice } from './move'

beforeAll(async () => {
  await ready()
})

function notice(url: string, keys = generateSigningKeyPair(), movedAt = 1_760_000_000_000) {
  const serverKey = b64u(keys.publicKey)
  const sig = b64u(sign(signedPayload(MOVE_CONTEXT, keys.publicKey, u64be(movedAt), new TextEncoder().encode(url)), keys.secretKey))
  return { serverKey, url, movedAt, sig, keys }
}

describe('server moved notices', () => {
  it('accepts a notice signed by the trusted server key', () => {
    const n = notice('https://new.example.com')
    expect(verifyMoveNotice(n, n.serverKey)).toBe(true)
  })

  it('refuses anything else', () => {
    const n = notice('https://new.example.com')
    const other = generateSigningKeyPair()
    // Another server's key, even with its own valid signature.
    const forged = notice('https://new.example.com', other)
    expect(verifyMoveNotice(forged, n.serverKey)).toBe(false)
    expect(verifyMoveNotice({ ...forged, serverKey: n.serverKey }, n.serverKey)).toBe(false)
    // A changed address or time breaks the signature.
    expect(verifyMoveNotice({ ...n, url: 'https://evil.example.com' }, n.serverKey)).toBe(false)
    expect(verifyMoveNotice({ ...n, movedAt: n.movedAt + 1 }, n.serverKey)).toBe(false)
    // Signed, but not a usable address.
    const js = notice('javascript:alert(1)', n.keys)
    expect(verifyMoveNotice(js, n.serverKey)).toBe(false)
    expect(verifyMoveNotice(null, n.serverKey)).toBe(false)
    expect(verifyMoveNotice({ ...n, sig: 'nope' }, n.serverKey)).toBe(false)
  })

  it('cleans addresses like the server does', () => {
    expect(cleanServerUrl('https://Chat.Example.com/')).toBe('https://chat.example.com')
    expect(cleanServerUrl('chat.example.com')).toBe('https://chat.example.com')
    expect(cleanServerUrl('http://192.168.1.20:47070')).toBe('http://192.168.1.20:47070')
    expect(cleanServerUrl('https://example.com:443')).toBe('https://example.com')
    expect(cleanServerUrl('ftp://example.com')).toBeNull()
    expect(cleanServerUrl('https://user:pw@example.com')).toBeNull()
    expect(cleanServerUrl('https://example.com/?x=1')).toBeNull()
    expect(sameServerUrl('https://A.example.com/', 'https://a.example.com')).toBe(true)
  })

  it('reads the server key a new address announces', async () => {
    class FakeSocket {
      onmessage: ((e: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: (() => void) | null = null
      url: string
      constructor(url: string) {
        this.url = url
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'hello', body: { serverKey: 'KEY', nonce: 'n' } }) }), 0)
      }
      close() {}
    }
    const key = await probeServerKey('https://new.example.com', 1000, FakeSocket as unknown as typeof WebSocket)
    expect(key).toBe('KEY')
  })
})
