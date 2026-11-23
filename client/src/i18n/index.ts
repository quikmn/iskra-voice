// Translations: i18next with English bundled in (it's also the fallback); other languages load when picked.
// Components use `useTranslation()` from react-i18next, so they re-render when the language changes;
// code outside React (notifications, state helpers) uses `t` from here.
import i18next, { type BackendModule } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { create } from 'zustand'
import { en } from './en'
import { isLanguage, languageInfo, languageOfTag, LANGUAGES, SHIPPED_LANGUAGES, SOURCE_LANGUAGE, withPluralForms, type Language } from './languages'
import type { LanguageChoice, Messages } from './types'

export { englishName, LANGUAGES, LANGUAGE_NAMES, SHIPPED_LANGUAGES, type Language } from './languages'
export type { LanguageChoice } from './types'

const STORAGE_KEY = 'iskra.language'

function browserLanguages(): readonly string[] {
  try {
    return typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  } catch {
    return []
  }
}

/** The first of the system's languages we ship, else English. */
export function systemLanguage(languages: readonly string[] = browserLanguages()): Language {
  for (const tag of languages) {
    const language = languageOfTag(tag, SHIPPED_LANGUAGES)
    if (language) return language
  }
  return SOURCE_LANGUAGE
}

export function loadLanguageChoice(storage?: Pick<Storage, 'getItem'>): LanguageChoice {
  try {
    const value = (storage ?? localStorage).getItem(STORAGE_KEY)
    // Any registered language, so one that isn't shipped yet can be tried by its code.
    return isLanguage(value) ? value : 'auto'
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

export const currentLanguage = (): Language => (isLanguage(i18next.language) ? i18next.language : SOURCE_LANGUAGE)

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
  return languageInfo(language).locale
}

/**
 * Fetches a language's catalog the first time it's used (each is about 100 KB of code): ./<code>/index.ts, which
 * exports the catalog under its code (`export const sv`). The bundler makes one chunk per folder from this pattern.
 */
const lazyCatalogs: BackendModule = {
  type: 'backend',
  init: () => undefined,
  read: (language, _namespace, done) => {
    if (!isLanguage(language) || language === SOURCE_LANGUAGE) return done(null, {})
    const catalog = import(`./${language}/index.ts`) as Promise<Record<string, Messages>>
    catalog.then((module) => done(null, withPluralForms(module[language], language)), (e: Error) => done(e, false))
  },
}

/** Settles once the starting language is in (right away for English): render after this, so there's no flash of English. */
export const i18nReady: Promise<unknown> = i18next.use(lazyCatalogs).use(initReactI18next).init({
  resources: { en: { translation: en } },
  partialBundledLanguages: true,
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
