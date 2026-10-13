import { describe, expect, it } from 'vitest'
import { blockedAsInsecure } from './connection'
import { appInviteLink, buildInviteLink, normalizeServerUrl, parseInvite, socketUrl } from './invite'

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

  it('carries the p2p secret as an optional fourth field, and old links still parse', () => {
    const p2p = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA'
    const invite = { serverUrl: 'http://192.168.1.20:47070', serverKey, code: 'abcdefghijklmnop', p2p }
    const link = buildInviteLink('https://app.iskra.foo', invite)
    expect(link.endsWith(`.abcdefghijklmnop.${p2p}`)).toBe(true)
    expect(parseInvite(link)).toEqual(invite)
    expect(parseInvite(appInviteLink(invite))).toEqual(invite)
    // Without it: exactly as before, no p2p key at all.
    expect(parseInvite(buildInviteLink('https://app.iskra.foo', { serverUrl: 'http://192.168.1.20:47070', serverKey, code: 'abcdefghijklmnop' }))).toEqual({
      serverUrl: 'http://192.168.1.20:47070', serverKey, code: 'abcdefghijklmnop',
    })
    // A fourth field that isn't a 32-byte secret, or a fifth field, is junk.
    expect(parseInvite(link.slice(0, -1))).toBeNull()
    expect(parseInvite(`${link}.extra`)).toBeNull()
    expect(buildInviteLink('x', { ...invite, p2p: 'short' })).not.toContain('short')
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

describe('iskra:// app links', () => {
  it('carry the same invite, and parse back', () => {
    const invite = { serverUrl: 'https://chat.example.com', serverKey: 'A'.repeat(43), code: 'abcdefgh12' }
    const link = appInviteLink(invite)
    expect(link).toMatch(/^iskra:\/\/join\/[A-Za-z0-9_-]+\.A{43}\.abcdefgh12$/)
    expect(parseInvite(link)).toEqual(invite)
  })
})
