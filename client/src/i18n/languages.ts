// The interface languages. This list is the only shared file a new language touches: add one line here, plus the
// language's own files (docs/translating.md lists them). No imports, so tests, e2e specs and tools can read it too.

export interface LanguageInfo {
  /** The code everything is keyed by: the catalog folder, the stored choice, `<html lang>`. Lower case, two or three letters. */
  code: string
  /** The language's own name, shown in the picker as is. */
  name: string
  /** The locale for dates and numbers when the system's own isn't in this language (`pt` → `pt-BR`). */
  locale: string
  /** Offered in My settings → Language and picked for a system in that language. Others load only when asked for by code. */
  shipped: boolean
}

// One line per language, sorted by code.
export const LANGUAGE_REGISTRY = [
  { code: 'en', name: 'English', locale: 'en-US', shipped: true },
  { code: 'sv', name: 'Svenska', locale: 'sv-SE', shipped: true },
] as const satisfies readonly LanguageInfo[]

export type Language = (typeof LANGUAGE_REGISTRY)[number]['code']

/** English is the source: bundled with the app, and what shows where a language has no text. */
export const SOURCE_LANGUAGE = 'en' satisfies Language

/** Every registered language, shipped or not. */
export const LANGUAGES: readonly Language[] = LANGUAGE_REGISTRY.map((l) => l.code)

/** The languages people can pick, by their own name (Latin script first, as the browser sorts them). */
export const SHIPPED_LANGUAGES: readonly Language[] = LANGUAGE_REGISTRY.filter((l) => l.shipped)
  .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  .map((l) => l.code)

export const isLanguage = (value: unknown): value is Language => typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)

export const languageInfo = (language: Language): LanguageInfo => LANGUAGE_REGISTRY.find((l) => l.code === language) ?? LANGUAGE_REGISTRY[0]

/** Each language's own name. */
export const LANGUAGE_NAMES = Object.fromEntries(LANGUAGE_REGISTRY.map((l) => [l.code, l.name])) as Record<Language, string>

/** "pt-BR" → "pt". */
export const baseLanguage = (tag: string | null | undefined): string => String(tag ?? '').toLowerCase().split(/[-_]/)[0]

/** The registered language a locale tag belongs to ("sv-FI" → "sv"), or null. */
export function languageOfTag(tag: string | null | undefined, among: readonly Language[] = LANGUAGES): Language | null {
  const base = baseLanguage(tag)
  return (among as readonly string[]).includes(base) ? (base as Language) : null
}

/** The language's name in English ("Swedish"), for text that is written in English (the assistant's prompt). */
export function englishName(language: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? 'English'
  } catch {
    return 'English'
  }
}

// ── Plurals ──────────────────────────────────────────────────────────────────

export const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'] as const
export type PluralForm = (typeof PLURAL_FORMS)[number]

/** Matches a plural key's suffix: "members_one" → "one". */
export const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

/** Every form the language can use (what `Intl.PluralRules` reports here; newer browsers add `many` for millions in es, fr, it, pt). */
export function pluralForms(language: string): PluralForm[] {
  return [...new Intl.PluralRules(language).resolvedOptions().pluralCategories] as PluralForm[]
}

/**
 * The forms a catalog must have for the language: those a whole number below a million can pick, plus `other`
 * (fractions, and what a missing form falls back to). English, Swedish, German, Spanish, French, Italian and
 * Portuguese: one, other. Russian and Polish: one, few, many, other.
 */
export function requiredPluralForms(language: string): PluralForm[] {
  const rules = new Intl.PluralRules(language)
  const used = new Set<string>(['other'])
  for (let n = 0; n <= 200; n++) used.add(rules.select(n))
  return PLURAL_FORMS.filter((form) => used.has(form))
}

type Tree = { [key: string]: string | Tree }

/**
 * A copy of a catalog where every plural text has all the forms this browser can ask for in the language, filled
 * from `_other`. Without it i18next shows English for a missing form (a Spanish "1 000 000" asks for `_many`).
 */
export function withPluralForms<T extends object>(catalog: T, language: string): T {
  const forms = pluralForms(language)
  const fill = (tree: Tree): Tree => {
    const out: Tree = {}
    for (const [key, value] of Object.entries(tree)) out[key] = typeof value === 'string' ? value : fill(value)
    for (const [key, value] of Object.entries(tree)) {
      if (typeof value !== 'string' || !key.endsWith('_other')) continue
      const base = key.slice(0, -'_other'.length)
      for (const form of forms) out[`${base}_${form}`] ??= value
    }
    return out
  }
  return fill(catalog as unknown as Tree) as unknown as T
}
