// Tests run as an English (US) browser, whatever the machine's language.
import { i18next } from '.'

try {
  Object.defineProperty(globalThis.navigator, 'languages', { value: ['en-US'], configurable: true })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'en-US', configurable: true })
} catch {
  // No navigator: intlLocale falls back to en-US anyway.
}
void i18next.changeLanguage('en')
