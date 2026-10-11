// Dates, times, numbers and sizes in the app's language (see intlLocale).
import { intlLocale } from '.'

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat>()

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat>(
  kind: string, options: object, make: (locale: string) => T,
): T {
  const locale = intlLocale()
  const key = `${kind}|${locale}|${JSON.stringify(options)}`
  let format = cache.get(key) as T | undefined
  if (!format) {
    format = make(locale)
    cache.set(key, format)
  }
  return format
}

export const dateTimeFormat = (options: Intl.DateTimeFormatOptions) =>
  cached('date', options, (locale) => new Intl.DateTimeFormat(locale, options))

export const formatDate = (ms: number | Date, options: Intl.DateTimeFormatOptions) => dateTimeFormat(options).format(ms)

export const formatNumber = (n: number, options: Intl.NumberFormatOptions = {}) =>
  cached('number', options, (locale) => new Intl.NumberFormat(locale, options)).format(n)

/** "in 3 days", "yesterday" */
export const formatRelative = (value: number, unit: Intl.RelativeTimeFormatUnit, numeric: 'auto' | 'always' = 'auto') =>
  cached('relative', { numeric }, (locale) => new Intl.RelativeTimeFormat(locale, { numeric })).format(value, unit)

/** "Anna, Bo and Cleo" */
export const formatList = (items: string[], type: 'conjunction' | 'disjunction' = 'conjunction') =>
  cached('list', { type }, (locale) => new Intl.ListFormat(locale, { type })).format(items)

/** "1.4 GB" (one decimal under 10, none above) */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = value < 10 ? 1 : 0
  return `${formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unit]}`
}
