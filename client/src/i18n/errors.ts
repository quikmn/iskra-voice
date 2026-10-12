// Errors shown to people. The server answers in English with a code, and for most messages a key (with args) that
// names the text: English shows the server's text, other languages the key's translation, else one by request type
// and code, else the server's text.
import { currentLanguage, i18next } from '.'
import { formatSpan } from './format'

interface CodedError {
  code?: unknown
  message?: unknown
  /** The request that failed (RequestError sets it). */
  type?: unknown
  key?: unknown
  args?: unknown
}

const has = (key: string) => i18next.exists(key, { lng: currentLanguage(), fallbackLng: false })

/** The translation for a server error code (and request type), or null when there isn't one. */
export function translatedError(code: string, type?: string): string | null {
  const keys = [...(type ? [`errors.requests.${type.replace(/\./g, '_')}.${code}`] : []), `errors.codes.${code}`]
  for (const key of keys) if (has(key)) return i18next.t(key as never) as string
  return null
}

/** The translation of a server message by its key (PROTOCOL.md → Errors), or null when this app doesn't know it. */
export function translatedServerMessage(key: string, args: Record<string, unknown> = {}): string | null {
  if (!/^[a-z0-9_]{1,64}$/.test(key) || !has(`errors.server.${key}`)) return null
  const values: Record<string, unknown> = { ...args }
  if (typeof args.seconds === 'number') values.wait = formatSpan(args.seconds)
  let text = i18next.t(`errors.server.${key}` as never, values as never) as unknown as string
  // AutoMod says how long the timeout it gave is.
  if (key.startsWith('automod_') && typeof args.timeoutMs === 'number' && args.timeoutMs > 0) {
    text += ' ' + (i18next.t('errors.automodTimedOut', { duration: formatSpan(args.timeoutMs / 1000) }) as string)
  }
  return text
}

/** What to show for an error: from the server, from the app, or anything thrown. */
export function errorMessage(error: unknown): string {
  const e = (error ?? {}) as CodedError
  const message = typeof e.message === 'string' && e.message ? e.message : null
  if (currentLanguage() !== 'en') {
    if (typeof e.key === 'string') {
      const translated = translatedServerMessage(e.key, e.args && typeof e.args === 'object' ? (e.args as Record<string, unknown>) : {})
      if (translated) return translated
    }
    if (typeof e.code === 'string') {
      const translated = translatedError(e.code, typeof e.type === 'string' ? e.type : undefined)
      if (translated) return translated
    }
  }
  return message ?? (typeof error === 'string' ? error : i18next.t('errors.generic'))
}
