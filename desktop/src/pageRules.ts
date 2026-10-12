// Profile pages in the desktop app: which <webview> sources the app page may open, and which requests a page's
// own session lets through. Pure functions, so they're unit-tested (pageRules.test.ts); pages.ts wires them up.

/** The in-memory session only profile pages use. Nothing else ever runs in it. */
export const PAGES_PARTITION = 'iskra-pages'

/** A preview (the author's own draft) arrives as one data: URL. Pages are ≤ 512 KB, so this is plenty. */
export const PREVIEW_PREFIX = 'data:text/html;charset=utf-8;base64,'
export const MAX_PREVIEW_URL = 800_000

const PAGE_PATH = /^\/pages\/[A-Za-z0-9_-]{16,64}$/

/**
 * What a <webview> may show: a published page with scripts (http(s)://host/pages/<id>?scripts=1, nothing more in
 * the URL) or an editor preview (a base64 HTML data: URL). Anything else is refused. Returns the canonical source.
 */
export function pageViewSource(src: unknown): { kind: 'page' | 'preview'; url: string } | null {
  if (typeof src !== 'string') return null
  if (src.startsWith(PREVIEW_PREFIX)) {
    return src.length <= MAX_PREVIEW_URL && /^[A-Za-z0-9+/]*={0,2}$/.test(src.slice(PREVIEW_PREFIX.length)) ? { kind: 'preview', url: src } : null
  }
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.hash || url.search !== '?scripts=1' || !PAGE_PATH.test(url.pathname)) return null
  return url.href === src ? { kind: 'page', url: url.href } : null
}

/**
 * Whether a page's session lets a request through. `allowed` is the page this view was opened on (null for a
 * preview, which needs nothing). Only that exact document, and images from the same server's /files/ (the page
 * policy allows those; that server is the one the viewer is already connected to). No other host, ever.
 */
export function pageRequestAllowed(allowed: string | null, url: string, resourceType: string, method: string): boolean {
  if (!allowed || method !== 'GET') return false
  if (resourceType === 'mainFrame') return url === allowed
  if (resourceType !== 'image') return false
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  const page = new URL(allowed)
  // Only http(s) pages have a real origin: data:, file: and app: URLs all share the opaque "null".
  if (page.origin === 'null' || !/^https?:$/.test(page.protocol) || !/^https?:$/.test(target.protocol)) return false
  return target.origin === page.origin && !target.username && !target.password && /^\/files\/[A-Za-z0-9_-]{16,64}(?:\/[^/]*)?$/.test(target.pathname)
}
