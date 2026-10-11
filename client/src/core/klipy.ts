// KLIPY, the GIF provider, as apps use it in "direct" mode (PROTOCOL.md, "GIFs"): the API addresses, reading its
// answers, and the only media hosts we ever load. Mirrors server/Gifs/GifService.cs. No DOM here.

export const KLIPY_API = 'https://api.klipy.com/api/v1/'
export const KLIPY_MEDIA_HOSTS = ['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com']
export const KLIPY_PER_PAGE = 24

export interface KlipyGif {
  id: string
  title: string
  url: string
  preview: string
  width: number
  height: number
}

export interface KlipyCategory {
  name: string
  query: string
  preview: string | null
}

/** Only https on the default port, no credentials, one of KLIPY's media hosts, and plain URL characters. */
export function isKlipyMediaUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 1024 || !/^https:\/\/[a-z0-9.]+\/[A-Za-z0-9/_.~%=&?+-]*$/.test(url)) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.port === '' && !u.username && !u.password && KLIPY_MEDIA_HOSTS.includes(u.hostname)
  } catch {
    return false
  }
}

type Kind = 'trending' | 'search' | 'categories'

export function klipyUrl(kind: Kind, key: string, params: { q?: string; page?: number; customerId?: string; locale?: string } = {}): string {
  const query = new URLSearchParams()
  if (kind !== 'categories') {
    query.set('page', String(params.page ?? 1))
    query.set('per_page', String(KLIPY_PER_PAGE))
    if (params.q) query.set('q', params.q)
    if (params.customerId) query.set('customer_id', params.customerId)
    query.set('content_filter', 'medium')
    query.set('format_filter', 'gif,webp')
  }
  if (params.locale) query.set('locale', params.locale)
  return `${KLIPY_API}${encodeURIComponent(key)}/gifs/${kind}?${query}`
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(4096, Math.round(v))) : 0)

function media(file: Record<string, unknown>, size: string, format: string): { url: string; width: number; height: number } | null {
  const s = file[size] as Record<string, unknown> | undefined
  const f = s && typeof s === 'object' ? (s[format] as Record<string, unknown> | undefined) : undefined
  if (!f || typeof f !== 'object' || !isKlipyMediaUrl(f.url)) return null
  return { url: f.url, width: num(f.width), height: num(f.height) }
}

/** A page of results: GIFs only (ads and anything else are left out), with addresses on KLIPY's media hosts. */
export function parseKlipyPage(json: unknown): { gifs: KlipyGif[]; hasNext: boolean } {
  const data = (json as { data?: { data?: unknown; has_next?: unknown } } | null)?.data
  const items = Array.isArray(data?.data) ? data.data : []
  const gifs: KlipyGif[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (item.type !== undefined && item.type !== 'gif') continue
    const id = str(item.slug) ?? (typeof item.id === 'number' ? String(item.id) : str(item.id))
    const file = item.file as Record<string, unknown> | undefined
    if (!id || id.length > 128 || !file || typeof file !== 'object') continue
    const full = media(file, 'md', 'webp') ?? media(file, 'md', 'gif') ?? media(file, 'hd', 'webp') ?? media(file, 'hd', 'gif')
    const preview = media(file, 'sm', 'webp') ?? media(file, 'sm', 'gif') ?? media(file, 'xs', 'gif') ?? full
    if (!full || !preview) continue
    gifs.push({ id, title: (str(item.title) ?? 'GIF').slice(0, 100) || 'GIF', url: full.url, preview: preview.url, width: full.width, height: full.height })
  }
  return { gifs, hasNext: data?.has_next === true }
}

export function parseKlipyCategories(json: unknown): KlipyCategory[] {
  const data = (json as { data?: unknown } | null)?.data
  const list = Array.isArray(data) ? data : Array.isArray((data as { categories?: unknown })?.categories) ? (data as { categories: unknown[] }).categories : []
  return list.flatMap((raw): KlipyCategory[] => {
    if (!raw || typeof raw !== 'object') return []
    const c = raw as Record<string, unknown>
    const name = (str(c.category) ?? str(c.name) ?? '').trim().slice(0, 40)
    const query = (str(c.query) ?? name).trim().slice(0, 100)
    if (!name || !query) return []
    return [{ name, query, preview: isKlipyMediaUrl(c.preview_url) ? c.preview_url : null }]
  }).slice(0, 50)
}

/**
 * A tiny document that shows one KLIPY image and can load nothing else: its own CSP allows images from KLIPY's media
 * hosts only, it runs no scripts (the frame is sandboxed), and sends no referrer. The address is checked first.
 */
export function klipyFrameDocument(url: string, alt: string): string | null {
  if (!isKlipyMediaUrl(url)) return null
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const hosts = KLIPY_MEDIA_HOSTS.map((h) => `https://${h}`).join(' ')
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${hosts}; style-src 'unsafe-inline'">`
    + `<meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;background:transparent}`
    + `img{display:block;width:100%;height:100%;object-fit:cover}</style><img src="${escape(url)}" alt="${escape(alt)}" referrerpolicy="no-referrer">`
}
