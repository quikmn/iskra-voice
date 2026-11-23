// The desktop shell's own text (tray, file pickers, the splash, the window title) in the app's language.
// The page tells us its language (My settings → Language, or the system's); until it has, the OS decides.
// Anything the shell *says* to the person (an update check's result, About, permissions) is worded by the page
// itself (client/src/i18n), which gets a structured notice (notices.ts).

// One file per language in ./text/<code>.ts (`export const text: DesktopText`); a language without one shows English.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { text as en, type DesktopText } from './text/en'

export type { DesktopText } from './text/en'

/** A language code as the page and the settings file give it ("sv", "pt"). It may have no desktop text: then English shows. */
export type DesktopLanguage = string

const CODE = /^[a-z]{2,3}$/

/** Every language file next to this one, by code. */
function loadTexts(): Record<string, DesktopText> {
  const texts: Record<string, DesktopText> = { en }
  let files: string[] = []
  try {
    files = readdirSync(join(__dirname, 'text'))
  } catch {
    // No folder (it can't be read): English only.
  }
  for (const file of files) {
    const code = /^([a-z]{2,3})\.js$/.exec(file)?.[1]
    if (!code || code === 'en') continue
    try {
      const loaded = (require(`./text/${code}.js`) as { text?: DesktopText }).text
      if (loaded) texts[code] = loaded
    } catch {
      // A file that doesn't load: that language shows English.
    }
  }
  return texts
}

export const DESKTOP_TEXT: Readonly<Record<string, DesktopText>> = loadTexts()

const hasText = (code: string): boolean => Object.hasOwn(DESKTOP_TEXT, code)

/** The first of the OS's preferred languages that we have text for, else English. */
export function languageFromLocales(locales: readonly string[]): DesktopLanguage {
  for (const tag of locales) {
    const base = String(tag).toLowerCase().split(/[-_]/)[0]
    if (hasText(base)) return base
  }
  return 'en'
}

/** A language code from the page or the settings file, or null for anything else. */
export const parseLanguage = (value: unknown): DesktopLanguage | null => (typeof value === 'string' && CODE.test(value) ? value : null)

/** The text for a language, or English where it has none. */
export const textFor = (language: DesktopLanguage): DesktopText => (hasText(language) ? DESKTOP_TEXT[language] : en)

let current: DesktopLanguage = 'en'

export function setDesktopLanguage(language: DesktopLanguage): void {
  current = language
}

export const desktopLanguage = (): DesktopLanguage => current

/** The text in the current language. */
export const text = (): DesktopText => textFor(current)
