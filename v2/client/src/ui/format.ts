const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dayTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function messageTime(ms: number, now = Date.now()): string {
  const date = new Date(ms)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return time.format(date)
  if (now - ms < 6 * 24 * 3600 * 1000) return dayTime.format(date)
  return full.format(date)
}

export const fullTime = (ms: number) => full.format(new Date(ms))

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

/** The web app's own address; invite links open it. */
export const appUrl = () => window.location.origin + window.location.pathname
