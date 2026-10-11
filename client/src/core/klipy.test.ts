import { describe, expect, it } from 'vitest'
import { isKlipyMediaUrl, klipyFrameDocument, klipyUrl, parseKlipyCategories, parseKlipyPage } from './klipy'

const item = (slug: string, host = 'static.klipy.com', type = 'gif') => ({
  slug, title: `A ${slug}`, type,
  file: {
    md: { gif: { url: `https://${host}/ii/${slug}/md.gif`, width: 300, height: 200 } },
    sm: { webp: { url: `https://${host}/ii/${slug}/sm.webp`, width: 150, height: 100 } },
  },
})

describe('KLIPY in direct mode', () => {
  it('builds API addresses with the key in the path', () => {
    const url = new URL(klipyUrl('search', 'k-1', { q: 'happy cat', page: 2, customerId: 'abc' }))
    expect(url.origin + url.pathname).toBe('https://api.klipy.com/api/v1/k-1/gifs/search')
    expect(url.searchParams.get('q')).toBe('happy cat')
    expect(url.searchParams.get('customer_id')).toBe('abc')
    expect(url.searchParams.get('page')).toBe('2')
    expect(klipyUrl('categories', 'a/b')).toContain('/a%2Fb/gifs/categories')
  })

  it('keeps GIFs on KLIPY hosts and drops ads and anything else', () => {
    const page = parseKlipyPage({ data: { data: [item('ok'), item('ad', undefined, 'ad'), item('evil', 'evil.example'), null, 'x'], has_next: true } })
    expect(page.hasNext).toBe(true)
    expect(page.gifs).toEqual([{ id: 'ok', title: 'A ok', url: 'https://static.klipy.com/ii/ok/md.gif', preview: 'https://static.klipy.com/ii/ok/sm.webp', width: 300, height: 200 }])
    expect(parseKlipyPage(null)).toEqual({ gifs: [], hasNext: false })
    expect(parseKlipyCategories({ data: { categories: [{ category: 'Cats', query: 'cat', preview_url: 'https://evil.example/x.gif' }] } }))
      .toEqual([{ name: 'Cats', query: 'cat', preview: null }])
  })

  it('accepts only KLIPY media addresses', () => {
    expect(isKlipyMediaUrl('https://static2.klipy.com/ii/a.gif?x=1&y=2')).toBe(true)
    for (const bad of ['http://static.klipy.com/a.gif', 'https://static.klipy.com:8443/a.gif', 'https://u:p@static.klipy.com/a.gif',
      'https://static.klipy.com.evil.example/a.gif', 'https://static.klipy.com/a.gif"onerror="x', 'javascript:alert(1)', 42]) {
      expect(isKlipyMediaUrl(bad), String(bad)).toBe(false)
    }
  })

  it('frames one image under a CSP that allows only KLIPY hosts', () => {
    const doc = klipyFrameDocument('https://static.klipy.com/ii/a.gif', 'A "cat" <b>')!
    expect(doc).toContain("img-src https://static.klipy.com https://static1.klipy.com https://static2.klipy.com;")
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain('alt="A &#34;cat&#34; &#60;b&#62;"')
    expect(klipyFrameDocument('https://evil.example/a.gif', 'x')).toBeNull()
  })
})
