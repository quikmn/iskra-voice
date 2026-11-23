import type { en } from './en'
import type { Language } from './languages'

/** Russian and Polish have `_few` and `_many` next to every `_one`/`_other`; any language may add `_zero`, `_two`, `_many`. */
type MorePlurals<T> = { [K in keyof T as K extends `${infer Base}_other` ? `${Base}_${'zero' | 'two' | 'few' | 'many'}` : never]?: string }

/** The catalog's shape with any text allowed: every other language must have exactly these keys (plus its plural forms). */
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> } & MorePlurals<T>

export type Messages = Widen<typeof en>

export { LANGUAGES, LANGUAGE_NAMES, SHIPPED_LANGUAGES, type Language } from './languages'
/** What My settings → Language stores: a language, or follow the system. */
export type LanguageChoice = Language | 'auto'
