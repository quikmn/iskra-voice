// Profile pages and server-added activities in the desktop app: which <webview> sources the app page may open, and
// which requests a view's own session lets through. Pure functions, so they're unit-tested (pageRules.test.ts); pages.ts wires them up.

/** The in-memory session only profile pages use. Nothing else ever runs in it. */
export const PAGES_PARTITION = 'iskra-pages'

/** A preview (the author's own draft) arrives as one data: URL. Pages are ≤ 512 KB, so this is plenty. */
export const PREVIEW_PREFIX = 'data:text/html;charset=utf-8;base64,'
export const MAX_PREVIEW_URL = 800_000

const PAGE_PATH = /^\/pages\/[A-Za-z0-9_-]{16,64}$/
/** An activity's start page on its server (PROTOCOL.md → Activities); its own files live next to it. */
const ACTIVITY_ENTRY = /^\/activities\/([A-Za-z0-9_-]{16,64})\/index\.html$/
/** A file inside one activity's bundle: parts of [A-Za-z0-9_.-], none starting with a dot (the server's own rule). */
const ACTIVITY_FILE = /^\/activities\/([A-Za-z0-9_-]{16,64})\/((?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}\/){0,7}[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63})$/
/** What an activity's page loads besides itself. */
const ACTIVITY_RESOURCES = new Set(['script', 'stylesheet', 'image', 'font', 'media'])

/**
 * What a <webview> may show: a published page with scripts (http(s)://host/pages/<id>?scripts=1, nothing more in
 * the URL), an editor preview (a base64 HTML data: URL), or a server-added activity's start page
 * (http(s)://host/activities/<id>/index.html). Anything else is refused. Returns the canonical source.
 */
export function pageViewSource(src: unknown): { kind: 'page' | 'preview' | 'activity'; url: string } | null {
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
  if (url.username || url.password || url.hash) return null
  // A server-added activity: its start page exactly, nothing more in the URL.
  if (ACTIVITY_ENTRY.test(url.pathname) && !url.search) return url.href === src ? { kind: 'activity', url: url.href } : null
  if (url.search !== '?scripts=1' || !PAGE_PATH.test(url.pathname)) return null
  return url.href === src ? { kind: 'page', url: url.href } : null
}

/** The activity a view shows (its id), or null when it shows a profile page or preview. */
function activityOf(allowed: string): { origin: string; id: string } | null {
  let url: URL
  try {
    url = new URL(allowed)
  } catch {
    return null
  }
  const match = ACTIVITY_ENTRY.exec(url.pathname)
  return match && /^https?:$/.test(url.protocol) ? { origin: url.origin, id: match[1] } : null
}

/** A GET for a file of that same activity, on its own server (scripts, styles, pictures, fonts, sounds). */
function activityFileAllowed(activity: { origin: string; id: string }, url: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  if (target.origin !== activity.origin || target.username || target.password || target.search || target.hash) return false
  const match = ACTIVITY_FILE.exec(target.pathname)
  return !!match && match[1] === activity.id && !match[2].split('/').some((part) => part.startsWith('.'))
}

/**
 * Whether a page's session lets a request through. `allowed` is the page this view was opened on (null for a
 * preview, which needs nothing). Only that exact document, and images from the same server's /files/ (the page
 * policy allows those; that server is the one the viewer is already connected to). No other host, ever.
 */
export function pageRequestAllowed(allowed: string | null, url: string, resourceType: string, method: string): boolean {
  if (!allowed || method !== 'GET') return false
  if (resourceType === 'mainFrame') return url === allowed
  const activity = activityOf(allowed)
  if (activity) return ACTIVITY_RESOURCES.has(resourceType) && activityFileAllowed(activity, url)
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

/**
 * What the app fetches for a view's session (its protocol handler can't tell resource types apart; webRequest already
 * checked them): the view's own document, or what that page or activity may load.
 */
export function pageFetchAllowed(allowed: string, url: string): boolean {
  if (url === allowed) return true
  return activityOf(allowed) ? activityFileAllowed(activityOf(allowed)!, url) : pageRequestAllowed(allowed, url, 'image', 'GET')
}
