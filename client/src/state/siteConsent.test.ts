import { beforeEach, describe, expect, it, vi } from 'vitest'

const local = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v),
  removeItem: (k: string) => void local.delete(k), clear: () => local.clear(), key: () => null, get length() { return local.size },
})

const { MAX_SITES, normalizeSite, parseSites, setAlwaysLoad, siteName, siteOfUrl, useSiteConsent, watchSourceSite, watchVideoSrc, withSite } = await import('./siteConsent')

describe('sites that load without a click', () => {
  beforeEach(() => {
    local.clear()
    useSiteConsent.setState({ sites: [] })
  })

  it('keeps plain host names only', () => {
    expect(normalizeSite('YouTube.com')).toBe('youtube.com')
    expect(normalizeSite('www.twitch.tv')).toBe('twitch.tv')
    expect(normalizeSite('videos.example.org')).toBe('videos.example.org')
    for (const bad of ['', 'localhost', 'https://youtube.com', 'youtube.com/x', 'a b.com', '<script>.com', 42, null, 'x'.repeat(300) + '.com']) {
      expect(normalizeSite(bad)).toBeNull()
    }
  })

  it('finds the site of a link', () => {
    expect(siteOfUrl('https://www.youtube.com/watch?v=x')).toBe('youtube.com')
    expect(siteOfUrl('http://cdn.example.net/movie.mp4')).toBe('cdn.example.net')
    expect(siteOfUrl('javascript:alert(1)')).toBeNull()
    expect(siteOfUrl('not a url')).toBeNull()
  })

  it("says where a watch party plays from (nothing to say for the group's own server)", () => {
    const server = 'https://chat.example.org'
    expect(watchSourceSite({ kind: 'youtube', url: null }, server)).toBe('youtube.com')
    expect(watchSourceSite({ kind: 'url', url: 'https://videos.example.net/a.mp4' }, server)).toBe('videos.example.net')
    expect(watchSourceSite({ kind: 'url', url: 'https://chat.example.org/files/x.mp4' }, server)).toBeNull()
    expect(watchSourceSite({ kind: 'file', url: '/files/abc' }, server)).toBeNull()
  })

  it("never plays a watch link whose site can't be read (it would skip the consent gate)", () => {
    // Security review L14: `//evil.com/v.mp4` had no site, so no gate, and the browser loaded it from evil.com.
    const server = 'https://chat.example.org'
    expect(watchSourceSite({ kind: 'url', url: '//evil.example/v.mp4' }, server)).toBeNull()
    for (const url of ['//evil.example/v.mp4', '/files/x.mp4', 'ftp://evil.example/v.mp4', 'javascript:alert(1)', 'not a url', ''])
      expect(watchVideoSrc({ kind: 'url', url }, server)).toBeNull()
    expect(watchVideoSrc({ kind: 'url', url: 'https://videos.example.net/a.mp4' }, server)).toBe('https://videos.example.net/a.mp4')
    // Files must be on the group's own server.
    expect(watchVideoSrc({ kind: 'file', url: '/files/abc' }, server)).toBe('https://chat.example.org/files/abc')
    for (const url of ['.evil.example/x', '@evil.example/x', '//evil.example/x', '/\\evil.example/x', 'https://evil.example/x', null])
      expect(watchVideoSrc({ kind: 'file', url }, server)).toBeNull()
    expect(watchVideoSrc({ kind: 'youtube', url: null }, server)).toBeNull()
  })

  it('names the sites it knows', () => {
    expect(siteName('youtube.com')).toBe('YouTube')
    expect(siteName('x.com')).toBe('X')
    expect(siteName('videos.example.org')).toBe('videos.example.org')
  })

  it('cleans a stored list', () => {
    expect(parseSites(['youtube.com', 'YOUTUBE.com', 'bad site', 7, 'twitch.tv'])).toEqual(['youtube.com', 'twitch.tv'])
    expect(parseSites('youtube.com')).toEqual([])
    expect(parseSites(null)).toEqual([])
    expect(parseSites(Array.from({ length: 80 }, (_, i) => `s${i}.example.com`))).toHaveLength(MAX_SITES)
  })

  it('adds newest first, without repeats, and removes', () => {
    let sites = withSite([], 'youtube.com', true)
    sites = withSite(sites, 'twitch.tv', true)
    sites = withSite(sites, 'youtube.com', true)
    expect(sites).toEqual(['youtube.com', 'twitch.tv'])
    expect(withSite(sites, 'youtube.com', false)).toEqual(['twitch.tv'])
    expect(withSite(sites, 'not a site', true)).toBe(sites)
  })

  it('remembers per device, across restarts', async () => {
    setAlwaysLoad('www.YouTube.com', true)
    expect(useSiteConsent.getState().sites).toEqual(['youtube.com'])
    expect(JSON.parse(local.get('iskra.alwaysLoadSites')!)).toEqual(['youtube.com'])

    vi.resetModules()
    const again = await import('./siteConsent')
    expect(again.useSiteConsent.getState().sites).toEqual(['youtube.com'])

    setAlwaysLoad('youtube.com', false)
    expect(useSiteConsent.getState().sites).toEqual([])
    expect(JSON.parse(local.get('iskra.alwaysLoadSites')!)).toEqual([])
  })

  it('starts empty: nothing loads by itself until you say so', async () => {
    local.set('iskra.alwaysLoadSites', '{not json')
    vi.resetModules()
    expect((await import('./siteConsent')).useSiteConsent.getState().sites).toEqual([])
  })
})
