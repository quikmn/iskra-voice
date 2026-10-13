// Other websites' players and posts (YouTube, Twitch, X, Reddit, a watch party's video link): nothing loads from them
// until you click, unless you ticked "Always load from <site>" for that site on this device. The list stays on this
// device (Settings → Privacy & data shows it, with a way to forget each site).
import { create } from 'zustand'

const KEY = 'iskra.alwaysLoadSites'
export const MAX_SITES = 50

/** Names for the sites Iskra knows; anything else shows as its address. */
const NAMES: Record<string, string> = { 'youtube.com': 'YouTube', 'twitch.tv': 'Twitch', 'x.com': 'X', 'reddit.com': 'Reddit' }

/** A site as the list keeps it: a plain host name, lower case, without "www.". Null for anything else. */
export function normalizeSite(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 253) return null
  const site = value.trim().toLowerCase().replace(/^www\./, '')
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(site) ? site : null
}

/** The site a link loads from (its host name), or null for links that aren't http(s). */
export function siteOfUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? normalizeSite(u.hostname) : null
  } catch {
    return null
  }
}

export const siteName = (site: string) => NAMES[site] ?? site

/**
 * Where a watch party's video plays from: YouTube, a link's own site, or null for files on the group's own server
 * (also a link back to that server: `serverUrl`).
 */
export function watchSourceSite(source: { kind: string; url?: string | null }, serverUrl: string): string | null {
  if (source.kind === 'youtube') return 'youtube.com'
  if (source.kind !== 'url' || !source.url) return null
  const site = siteOfUrl(source.url)
  return site && site !== siteOfUrl(serverUrl) ? site : null
}

/**
 * The address a watch party's video plays from, or null when it can't be read safely: a `url` source must be an
 * absolute http(s) link, a `file` source a path on the group's own server. Servers check this too, but a link that
 * slips past (only a malicious server could send one) must never play without the consent gate, so it doesn't play.
 */
export function watchVideoSrc(source: { kind: string; url?: string | null }, serverUrl: string): string | null {
  if (!source.url) return null
  if (source.kind === 'url') return siteOfUrl(source.url) ? source.url : null
  if (source.kind !== 'file' || !source.url.startsWith('/') || source.url.startsWith('//') || source.url.includes('\\')) return null
  try {
    const src = new URL(serverUrl + source.url)
    return src.origin === new URL(serverUrl).origin ? src.href : null
  } catch {
    return null
  }
}

/** A stored list, cleaned: valid sites only, no repeats, at most MAX_SITES. */
export function parseSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const sites: string[] = []
  for (const item of raw) {
    const site = normalizeSite(item)
    if (site && !sites.includes(site)) sites.push(site)
  }
  return sites.slice(0, MAX_SITES)
}

/** The list with `site` added (newest first) or removed. */
export function withSite(sites: string[], site: string, on: boolean): string[] {
  const clean = normalizeSite(site)
  if (!clean) return sites
  const others = sites.filter((s) => s !== clean)
  return on ? [clean, ...others].slice(0, MAX_SITES) : others
}

function load(): string[] {
  try {
    return parseSites(JSON.parse(localStorage.getItem(KEY) ?? '[]'))
  } catch {
    return []
  }
}

export const useSiteConsent = create<{ sites: string[] }>(() => ({ sites: load() }))

/** Whether this device loads `site` without asking. */
export const useAlwaysLoads = (site: string | null) => useSiteConsent((s) => !!site && s.sites.includes(site))

export function setAlwaysLoad(site: string, on: boolean): void {
  const sites = withSite(useSiteConsent.getState().sites, site, on)
  useSiteConsent.setState({ sites })
  try {
    localStorage.setItem(KEY, JSON.stringify(sites))
  } catch {
    /* private mode: remembered until the app closes */
  }
}
