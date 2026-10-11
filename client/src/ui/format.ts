import { dateTimeFormat } from '../i18n/format'

// In the app's language (formatters are cached per locale).
const time = () => dateTimeFormat({ hour: '2-digit', minute: '2-digit' })
const dayTime = () => dateTimeFormat({ weekday: 'short', hour: '2-digit', minute: '2-digit' })
const full = () => dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' })

export function messageTime(ms: number, now = Date.now()): string {
  const date = new Date(ms)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return time().format(date)
  if (now - ms < 6 * 24 * 3600 * 1000) return dayTime().format(date)
  return full().format(date)
}

export const fullTime = (ms: number) => full().format(new Date(ms))

/** Just the clock time ("06:01 PM"), for grouped messages. */
export const clockTime = (ms: number) => time().format(new Date(ms))

/** A stable hue per account, so avatars and names are recognisable. */
export function hueFor(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return Math.abs(hash) % 360
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 2)
  return [...letters].slice(0, 2).join('').toUpperCase()
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The web app address invite links open: the server's configured one, else this page if it's a web page.
 * (In the desktop app this page is app://, which nobody else could open.)
 */
export function appUrl(serverAppUrl?: string | null): string {
  if (serverAppUrl) return serverAppUrl
  const here = window.location.origin + window.location.pathname
  return here.startsWith('http') ? here : 'https://app.iskra.foo/'
}
