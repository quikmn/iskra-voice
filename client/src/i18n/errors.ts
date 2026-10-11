// Errors shown to people. The server answers in English with a code: English shows the server's text,
// other languages a translation by request type and code, else the server's text.
import { currentLanguage, i18next } from '.'

interface CodedError {
  code?: unknown
  message?: unknown
  /** The request that failed (RequestError sets it). */
  type?: unknown
}

/** The translation for a server error code (and request type), or null when there isn't one. */
export function translatedError(code: string, type?: string): string | null {
  const keys = [...(type ? [`errors.requests.${type.replace(/\./g, '_')}.${code}`] : []), `errors.codes.${code}`]
  for (const key of keys) {
    if (i18next.exists(key, { lng: currentLanguage(), fallbackLng: false })) return i18next.t(key as never) as string
  }
  return null
}

/** What to show for an error: from the server, from the app, or anything thrown. */
export function errorMessage(error: unknown): string {
  const e = (error ?? {}) as CodedError
  const message = typeof e.message === 'string' && e.message ? e.message : null
  if (currentLanguage() !== 'en' && typeof e.code === 'string') {
    const translated = translatedError(e.code, typeof e.type === 'string' ? e.type : undefined)
    if (translated) return translated
  }
  return message ?? (typeof error === 'string' ? error : i18next.t('errors.generic'))
}
