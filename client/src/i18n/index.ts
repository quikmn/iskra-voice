// Translations: i18next with the catalogs bundled in (no loading), English as the fallback.
// Components use `useTranslation()` from react-i18next, so they re-render when the language changes;
// code outside React (notifications, state helpers) uses `t` from here.
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { create } from 'zustand'
import { en } from './en'
import { sv } from './sv'
import { LANGUAGES, type Language, type LanguageChoice } from './types'

export { LANGUAGES, LANGUAGE_NAMES, type Language, type LanguageChoice } from './types'

const STORAGE_KEY = 'iskra.language'

function browserLanguages(): readonly string[] {
  try {
    return typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  } catch {
    return []
  }
}

/** The first of the system's languages we have, else English. */
export function systemLanguage(languages: readonly string[] = browserLanguages()): Language {
  for (const tag of languages) {
    const base = tag?.toLowerCase().split('-')[0]
    if ((LANGUAGES as readonly string[]).includes(base)) return base as Language
  }
  return 'en'
}

export function loadLanguageChoice(storage?: Pick<Storage, 'getItem'>): LanguageChoice {
  try {
    const value = (storage ?? localStorage).getItem(STORAGE_KEY)
    return value && (LANGUAGES as readonly string[]).includes(value) ? (value as Language) : 'auto'
  } catch {
    return 'auto'
  }
}

export const resolveLanguage = (choice: LanguageChoice, languages?: readonly string[]): Language =>
  choice === 'auto' ? systemLanguage(languages) : choice

/** The picker's state: what the person chose (the applied language is `i18next.language`). */
export const useLanguageChoice = create<{ choice: LanguageChoice }>(() => ({ choice: loadLanguageChoice() }))

const listeners = new Set<(language: Language) => void>()

/** Runs on every language change (and now), e.g. to tell the desktop app. Returns an unsubscribe. */
export function onLanguage(listener: (language: Language) => void): () => void {
  listeners.add(listener)
  listener(currentLanguage())
  return () => listeners.delete(listener)
}

export const currentLanguage = (): Language => (i18next.language === 'sv' ? 'sv' : 'en')

export function setLanguageChoice(choice: LanguageChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Private mode: the choice lasts until the page closes.
  }
  useLanguageChoice.setState({ choice })
  void i18next.changeLanguage(resolveLanguage(choice))
}

/**
 * The locale for dates and numbers: the browser's own when it's the same language (so en-GB keeps its
 * 24-hour clock), else the language's usual one.
 */
export function intlLocale(language: Language = currentLanguage(), languages: readonly string[] = browserLanguages()): string {
  const own = languages.find((tag) => tag?.toLowerCase().split('-')[0] === language)
  if (own) {
    try {
      return Intl.getCanonicalLocales(own)[0]
    } catch {
      // A malformed tag: use the default below.
    }
  }
  return language === 'sv' ? 'sv-SE' : 'en-US'
}

void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, sv: { translation: sv } },
  lng: resolveLanguage(useLanguageChoice.getState().choice),
  fallbackLng: 'en',
  supportedLngs: [...LANGUAGES],
  initAsync: false,
  returnNull: false,
  interpolation: { escapeValue: false }, // React escapes
  react: { useSuspense: false },
})

function applied(language: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language
  for (const listener of listeners) listener(currentLanguage())
}
applied(i18next.language)
i18next.on('languageChanged', applied)

// "Automatic" follows the system when it changes.
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    if (useLanguageChoice.getState().choice === 'auto') void i18next.changeLanguage(systemLanguage())
  })
}

/** Translate outside React. In components, prefer `useTranslation()` so the text follows language changes. */
export const t = i18next.t.bind(i18next) as typeof i18next.t

export { i18next }
