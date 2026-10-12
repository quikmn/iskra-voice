import { beforeAll, describe, expect, it } from 'vitest'
import { ready } from './crypto'
import serverPages from '../../../server/src/Iskra.Server/Features/ProfilePages.cs?raw'
import { authProfile, MAX_PAGE_BYTES, PAGE_PRELUDE, pageUrl, previewDocument, previewSource, PREVIEW_PREFIX, profileForLink, profileFromLink, sha256Hex, wrapperDocument } from './profile'

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

  it('shows pages without scripts unless the viewer turns them on', () => {
    const off = wrapperDocument('http://localhost:1/pages/abc')
    expect(off).toContain('src="http://localhost:1/pages/abc" sandbox=""')
    expect(off).not.toContain('allow-scripts')
    const on = wrapperDocument('http://localhost:1/pages/abc', true)
    expect(on).toContain('src="http://localhost:1/pages/abc?scripts=1" sandbox="allow-scripts"')
    expect(on).toContain('frame-src http://localhost:1/pages/abc;')
  })

  it('hands the desktop preview one base64 data: URL with the policy inside', () => {
    const src = previewSource('<!doctype html><p>hej ✨</p>')
    expect(src.startsWith(PREVIEW_PREFIX)).toBe(true)
    expect(/^[A-Za-z0-9+/]*={0,2}$/.test(src.slice(PREVIEW_PREFIX.length))).toBe(true)
    const html = new TextDecoder().decode(Uint8Array.from(atob(src.slice(PREVIEW_PREFIX.length)), (c) => c.charCodeAt(0)))
    expect(html).toBe(previewDocument('<!doctype html><p>hej ✨</p>', null))
    expect(html).toContain("connect-src 'none'")
  })

  it('uses the same prelude as the server', () => {
    expect(/Prelude = """(.*?)""";/.exec(serverPages)?.[1]).toBe(PAGE_PRELUDE)
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

describe('profiles over device linking', () => {
  it('round-trips and recomputes hashes', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const sent = profileForLink({ name: 'A', bio: 'hi', accent: '#123456', avatar: { bytes: bytes.buffer, type: 'image/png', hash: 'x' }, page: { html: '<p>x</p>', hash: 'y' } })
    const got = profileFromLink(JSON.parse(JSON.stringify(sent)))
    expect(got.bio).toBe('hi')
    expect(got.accent).toBe('#123456')
    expect(new Uint8Array(got.avatar!.bytes)).toEqual(bytes)
    expect(got.avatar!.hash).toBe(sha256Hex(bytes))
    expect(got.page).toEqual({ html: '<p>x</p>', hash: sha256Hex(new TextEncoder().encode('<p>x</p>')) })
    expect(profileFromLink({}).avatar).toBeUndefined()
  })

  it('drops anything malformed', () => {
    const got = profileFromLink({ bio: 'x'.repeat(191), accent: 'red', avatar: { data: 'AQID', type: 'text/html' }, page: { html: 'x'.repeat(MAX_PAGE_BYTES + 1) } })
    expect(got).toEqual({})
    expect(profileFromLink('nope')).toEqual({})
    expect(profileFromLink({ avatar: null, page: null })).toEqual({ avatar: null, page: null })
  })
})
