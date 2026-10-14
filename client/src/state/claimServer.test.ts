import sodium from 'libsodium-wrappers-sumo'
import { describe, expect, it } from 'vitest'
import { b64u, fromB64u, ready } from '../core/crypto'
import { ClaimFailed, claimAddress, claimFromCode, claimServer, normalizeCode } from './claimServer'

// The server's side (OwnerSetup.cs), to answer like a real server would.
const enc = (s: string) => new TextEncoder().encode(s)
const serverProof = (claim: string, key: string, nonce: string) =>
  b64u(sodium.crypto_auth_hmacsha256(enc(`iskra-owner-proof-v1\n${key}\n${nonce}`), fromB64u(claim)))
const KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'

/** A server with a pending claim for `code`; records what was asked. */
function server(code: string, status = 200) {
  const asked: string[] = []
  const fetcher = (async (url: string) => {
    asked.push(url)
    const nonce = new URL(url).searchParams.get('nonce')!
    if (status !== 200) return new Response(null, { status })
    return Response.json({ iskra: 1, key: KEY, proof: serverProof(await claimFromCode(code), KEY, nonce) })
  }) as typeof fetch
  return { fetcher, asked }
}

describe('claim codes', () => {
  it('reads codes the way people type them', () => {
    expect(normalizeCode('0123-4567-89AB-CDEF')).toBe('0123456789ABCDEF')
    expect(normalizeCode(' o123 4567 89ab cdef ')).toBe('0123456789ABCDEF')
    expect(normalizeCode('0iL3-4567-89AB-CDEF')).toBe('0113456789ABCDEF')
    expect(normalizeCode('0123-4567-89AB-CDE')).toBeNull()
    expect(normalizeCode('0123-4567-89AB-CDEU')).toBeNull()
    expect(normalizeCode('')).toBeNull()
  })

  it('derives the same claim as the server', async () => {
    await ready()
    // Same vectors as GeneratedClaimTests.cs.
    expect(await claimFromCode('0123-4567-89ab-cdef')).toBe('DkY0DuPWq38gVMWGJNOYG24iiiCETvISXm8_Mu5dRik')
    await expect(claimFromCode('nope')).rejects.toThrow()
  })
})

describe('claim addresses', () => {
  it('takes URLs, host names and IPv4 addresses', () => {
    expect(claimAddress('https://203-0-113-7.sslip.io')).toBe('https://203-0-113-7.sslip.io')
    expect(claimAddress(' 203-0-113-7.sslip.io/ ')).toBe('https://203-0-113-7.sslip.io')
    expect(claimAddress('203.0.113.7')).toBe('https://203-0-113-7.sslip.io')
    expect(claimAddress('https://chat.example.com:8443')).toBe('https://chat.example.com:8443')
    expect(claimAddress('http://localhost:47070')).toBe('http://localhost:47070')
    expect(claimAddress('http://192.168.1.20:47070')).toBe('http://192.168.1.20:47070')
  })

  it('refuses plain HTTP on the internet, paths and junk', () => {
    expect(claimAddress('http://203-0-113-7.sslip.io')).toBeNull()
    expect(claimAddress('https://example.com/join')).toBeNull()
    expect(claimAddress('https://user:pw@example.com')).toBeNull()
    expect(claimAddress('ftp://example.com')).toBeNull()
    expect(claimAddress('192.168.1.5')).toBeNull() // a bare private address has no sslip.io name
    expect(claimAddress('')).toBeNull()
  })
})

describe('claimServer', () => {
  const code = '7KQ2-ZM8P-X4TD-9HRA'

  it('checks the proof and returns the owner invite; the code never leaves the device', async () => {
    const { fetcher, asked } = server(code)
    const invite = await claimServer('https://203-0-113-7.sslip.io', code.toLowerCase(), { fetcher })
    expect(invite.serverUrl).toBe('https://203-0-113-7.sslip.io')
    expect(invite.serverKey).toBe(KEY)
    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/^https:\/\/203-0-113-7\.sslip\.io\/\.well-known\/iskra-claim\?nonce=[A-Za-z0-9_-]{22}$/)
    expect(asked[0]).not.toContain(code.replaceAll('-', ''))
  })

  it('says what went wrong', async () => {
    const reason = (p: Promise<unknown>) => p.then(() => null, (e: ClaimFailed) => e.reason)
    expect(await reason(claimServer('https://a.example', 'AAAA-AAAA-AAAA-AAAA', { fetcher: server(code).fetcher }))).toBe('wrongCode')
    expect(await reason(claimServer('https://a.example', code, { fetcher: server(code, 404).fetcher }))).toBe('noClaim')
    expect(await reason(claimServer('https://a.example', code, { fetcher: server(code, 429).fetcher }))).toBe('busy')
    expect(await reason(claimServer('https://a.example', code, { fetcher: (async () => { throw new TypeError('offline') }) as typeof fetch }))).toBe('unreachable')
    expect(await reason(claimServer('https://a.example', code, { fetcher: (async () => Response.json({ key: 'x', proof: 'y' })) as typeof fetch }))).toBe('unreachable')
  })
})
