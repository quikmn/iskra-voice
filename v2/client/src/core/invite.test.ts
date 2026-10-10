import { describe, expect, it } from 'vitest'
import { blockedAsInsecure } from './connection'
import { buildInviteLink, normalizeServerUrl, parseInvite, socketUrl } from './invite'

const serverKey = '7UkoxijRwsbq6QM4kFmVYSlZJzpcY_k2NsFGFKyHN9E'

describe('invite links', () => {
  it('round-trips', () => {
    const invite = { serverUrl: 'https://chat.example.com', serverKey, code: 'abcdefghijklmnop' }
    const link = buildInviteLink('https://app.iskra.foo/', invite)
    expect(link.startsWith('https://app.iskra.foo/#/join/')).toBe(true)
    expect(parseInvite(link)).toEqual(invite)
  })

  it('accepts just the hash or the token', () => {
    const link = buildInviteLink('http://localhost:5173', { serverUrl: 'http://localhost:7070', serverKey, code: 'code12345' })
    const hash = link.slice(link.indexOf('#'))
    expect(parseInvite(hash)?.serverUrl).toBe('http://localhost:7070')
    expect(parseInvite(hash.replace('#/join/', ''))?.code).toBe('code12345')
  })

  it('matches what the server writes in owner-invite.txt', () => {
    // b64u("http://localhost:7070") as produced by the C# OwnerSetup.InviteLink
    const parsed = parseInvite(`http://localhost:5173/#/join/aHR0cDovL2xvY2FsaG9zdDo3MDcw.${serverKey}.AAAAAAAAAAAAAAAAAAAAAA`)
    expect(parsed?.serverUrl).toBe('http://localhost:7070')
  })

  it('rejects junk and dangerous URLs', () => {
    expect(parseInvite('')).toBeNull()
    expect(parseInvite('hello')).toBeNull()
    expect(parseInvite('a.b.c')).toBeNull()
    const js = buildInviteLink('x', { serverUrl: 'javascript:alert(1)', serverKey, code: 'code12345' })
    expect(parseInvite(js)).toBeNull()
  })

  it('normalizes server URLs', () => {
    expect(normalizeServerUrl('http://localhost:7070/')).toBe('http://localhost:7070')
    expect(normalizeServerUrl('ftp://x')).toBeNull()
    expect(normalizeServerUrl('https://user:pw@x.com')).toBeNull()
    expect(socketUrl('https://x.com')).toBe('wss://x.com/ws')
    expect(socketUrl('http://localhost:7070')).toBe('ws://localhost:7070/ws')
  })
})

describe('mixed content', () => {
  it('knows when a browser will refuse an insecure server', () => {
    expect(blockedAsInsecure('http://192.168.1.10:47070', 'https:')).toBe(true)
    expect(blockedAsInsecure('http://localhost:47070', 'https:')).toBe(false)
    expect(blockedAsInsecure('https://chat.example.com', 'https:')).toBe(false)
    expect(blockedAsInsecure('http://192.168.1.10:47070', 'app:')).toBe(false) // desktop app
    expect(blockedAsInsecure('http://192.168.1.10:47070', 'http:')).toBe(false)
  })
})
