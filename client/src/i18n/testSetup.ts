// Tests run as an English (US) browser, whatever the machine's language.
import { i18next, LANGUAGES } from '.'

try {
  Object.defineProperty(globalThis.navigator, 'languages', { value: ['en-US'], configurable: true })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'en-US', configurable: true })
} catch {
  // No navigator: intlLocale falls back to en-US anyway.
}
await i18next.changeLanguage('en')
// The app fetches a language when it's picked; tests read them directly (getFixedT('sv')), so have them all in.
await i18next.loadLanguages(LANGUAGES.filter((language) => language !== 'en'))
