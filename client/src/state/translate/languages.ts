// Which languages translation covers, and how to get from one to another: every model goes to or from English, so
// Swedish to German is Swedish → English → German (Bergamot pivots inside one call). No DOM: also used by the worker.
import pins from './models.json'

export interface ModelPin {
  name: string
  from: string
  to: string
  dir: string
  source: string
  files: { name: string; from: string; sha256: string; bytes: number; unpacked: { sha256: string; bytes: number }; parts: { sha256: string; bytes: number }[] }[]
}

export const PINS = pins.models as ModelPin[]
export const PIVOT = 'en'

const byName = new Map(PINS.map((p) => [p.name, p]))

/** English and every language with models both ways, English first. */
export const TRANSLATE_LANGUAGES: string[] = [PIVOT, ...[...new Set(PINS.map((p) => (p.from === PIVOT ? p.to : p.from)))].sort()]

export const pinFor = (name: string): ModelPin | undefined => byName.get(name)

/** The models from `from` to `to`, in order (one, or two through English); null when there's no way. Empty when they're the same. */
export function route(from: string, to: string): string[] | null {
  if (from === to) return []
  if (byName.has(`${from}-${to}`)) return [`${from}-${to}`]
  if (from === PIVOT || to === PIVOT) return null
  const first = `${from}-${PIVOT}`
  const second = `${PIVOT}-${to}`
  return byName.has(first) && byName.has(second) ? [first, second] : null
}

/** What the models in `names` weigh as downloaded (gzip, as the server serves them). */
export const modelBytes = (names: string[]): number => names.reduce((n, name) => n + (pinFor(name)?.files.reduce((m, f) => m + f.bytes, 0) ?? 0), 0)

/** One language both ways with English (what an owner sees per language). */
export const languageBytes = (language: string): number => modelBytes([`${PIVOT}-${language}`, `${language}-${PIVOT}`])

/** A language's name in `locale` ("svenska", "German"), or its code if the browser can't name it. */
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : code
  } catch {
    return code
  }
}
