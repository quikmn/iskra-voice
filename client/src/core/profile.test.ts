import { beforeAll, describe, expect, it } from 'vitest'
import { ready } from './crypto'
import { authProfile, pageUrl, previewDocument, sha256Hex, wrapperDocument } from './profile'

beforeAll(ready)

describe('profiles', () => {
  it('hashes like the server', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('only sends fields set on this device', () => {
    expect(authProfile({ name: 'A' })).toEqual({})
    expect(authProfile({ name: 'A', bio: '', accent: '#123456' })).toEqual({ bio: '', accent: '#123456' })
  })

  it('accepts only well-formed page addresses', () => {
    expect(pageUrl('http://localhost:47070', '/pages/AAAAAAAAAAAAAAAAAAAAAA')).toBe('http://localhost:47070/pages/AAAAAAAAAAAAAAAAAAAAAA')
    expect(pageUrl('https://chat.example.com/', '/pages/AAAAAAAAAAAAAAAAAAAAAA')).toBe('https://chat.example.com/pages/AAAAAAAAAAAAAAAAAAAAAA')
    expect(pageUrl('http://localhost:47070', '/files/AAAAAAAAAAAAAAAAAAAAAA/x.html')).toBeNull()
    expect(pageUrl('http://localhost:47070', '/pages/AAAAAAAAAAAAAAAAAAAAAA" onload="x')).toBeNull()
    expect(pageUrl('javascript:alert(1)', '/pages/AAAAAAAAAAAAAAAAAAAAAA')).toBeNull()
    expect(pageUrl('http://localhost', null)).toBeNull()
  })

  it('locks the wrapper to one address', () => {
    expect(wrapperDocument('http://localhost:1/pages/abc')).toContain("frame-src http://localhost:1/pages/abc;")
    expect(wrapperDocument(null)).toContain("frame-src 'none';")
    expect(wrapperDocument('x" onload="alert(1)')).not.toContain('" onload')
  })

  it('puts the preview policy before the page, after its doctype', () => {
    const doc = previewDocument('<!DOCTYPE html><p>hi</p>', null)
    expect(doc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(doc).toContain("connect-src 'none'")
    expect(doc).toContain('RTCPeerConnection')
    expect(doc.endsWith('<p>hi</p>')).toBe(true)
    expect(previewDocument('<p>x</p>', null).startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
  })
})
