import type { en } from './en'

/** The catalog's shape with any text allowed: every other language must have exactly these keys. */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> }

export type Messages = Widen<typeof en>

export const LANGUAGES = ['en', 'sv'] as const
export type Language = (typeof LANGUAGES)[number]
/** What Settings → Appearance stores: a language, or follow the system. */
export type LanguageChoice = Language | 'auto'

/** Each language's own name, shown in the picker as is. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', sv: 'Svenska' }
