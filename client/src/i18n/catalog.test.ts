import i18nextLibrary from 'i18next'
import { describe, expect, it } from 'vitest'
import { en } from './en'
import { i18next, intlLocale, loadLanguageChoice, resolveLanguage, systemLanguage, t } from '.'
import { errorMessage, translatedError } from './errors'
import { formatBytes } from './format'
import {
  englishName, LANGUAGE_REGISTRY, languageInfo, LANGUAGES, languageOfTag, oneMeansOne, PLURAL_SUFFIX, pluralForms, requiredPluralForms, SHIPPED_LANGUAGES, withPluralForms,
} from './languages'
import { RequestError } from '../core/protocol'

type Tree = { readonly [key: string]: string | Tree }

function flatten(tree: Tree, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[path] = value
    else flatten(value, path, out)
  }
  return out
}

const variables = (text: string) => [...text.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)].map((m) => m[1]).sort()
const tags = (text: string) => [...text.matchAll(/<(\/?\w+)\s*\/?>/g)].map((m) => m[1]).sort()
const baseOf = (key: string) => key.replace(PLURAL_SUFFIX, '')
const isPlural = (key: string) => PLURAL_SUFFIX.test(key)

// Every catalog folder (./<code>/index.ts exports the catalog under its code), found the way the app finds them.
const FOUND = Object.entries(import.meta.glob<Record<string, Tree>>('./*/index.ts', { eager: true }))
  .map(([file, module]) => [file.split('/')[1], module] as const)
const catalogs: Record<string, Record<string, string>> = Object.fromEntries(FOUND.map(([code, module]) => [code, flatten(module[code] ?? {})]))
const source = flatten(en)
const others = Object.keys(catalogs).filter((code) => code !== 'en')
const plainKeys = (catalog: Record<string, string>) => Object.keys(catalog).filter((k) => !isPlural(k)).sort()
const pluralBases = (catalog: Record<string, string>) => [...new Set(Object.keys(catalog).filter(isPlural).map(baseOf))].sort()
/** The English text a key translates: a form English doesn't have (Russian `_few`) goes with English's `_other`. */
const englishFor = (key: string): string | undefined => source[key] ?? source[`${baseOf(key)}_other`]

describe('the language list', () => {
  it('has one well-formed line per language, sorted by code, each with a catalog folder', () => {
    expect(LANGUAGE_REGISTRY.map((l) => l.code)).toEqual([...LANGUAGES].sort())
    expect(new Set(LANGUAGES).size).toBe(LANGUAGES.length)
    expect(Object.keys(catalogs).sort()).toEqual([...LANGUAGES].sort())
    for (const { code, name, locale } of LANGUAGE_REGISTRY) {
      expect(code).toMatch(/^[a-z]{2,3}$/)
      expect(name.trim()).toBe(name)
      expect(name.length).toBeGreaterThan(1)
      // The default locale is a real one, in that language.
      expect(Intl.getCanonicalLocales(locale)).toEqual([locale])
      expect(languageOfTag(locale)).toBe(code)
      expect(Intl.DateTimeFormat.supportedLocalesOf(locale)).toEqual([locale])
      expect(englishName(code)).not.toBe(code)
    }
    expect(SHIPPED_LANGUAGES).toContain('en')
  })

  it('names every catalog after its folder', () => {
    for (const [code, module] of FOUND) expect(Object.keys(module), code).toContain(code)
  })
})

describe('catalogs', () => {
  it('have exactly the same keys as English', () => {
    for (const lang of others) {
      const catalog = catalogs[lang]
      expect(plainKeys(catalog).filter((k) => source[k] === undefined).map((k) => `${lang}:${k} (not in English)`)).toEqual([])
      expect(plainKeys(source).filter((k) => catalog[k] === undefined).map((k) => `${lang}:${k} (missing)`)).toEqual([])
      expect(pluralBases(catalog).filter((b) => !pluralBases(source).includes(b)).map((b) => `${lang}:${b} (not a plural in English)`)).toEqual([])
      expect(pluralBases(source).filter((b) => !pluralBases(catalog).includes(b)).map((b) => `${lang}:${b} (missing)`)).toEqual([])
    }
  })

  it('have every plural form each language needs, and none it never uses', () => {
    const wrong: string[] = []
    for (const [lang, catalog] of Object.entries(catalogs)) {
      const required = requiredPluralForms(lang)
      const allowed = new Set<string>(pluralForms(lang))
      for (const base of pluralBases(catalog)) {
        for (const form of required) if (catalog[`${base}_${form}`] === undefined) wrong.push(`${lang}:${base}_${form} (missing)`)
      }
      for (const key of Object.keys(catalog).filter(isPlural)) {
        if (!allowed.has(PLURAL_SUFFIX.exec(key)![1])) wrong.push(`${lang}:${key} (never used in this language)`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('have no empty texts, and spaces at the ends only where English has them', () => {
    const bad: string[] = []
    const edges = (s: string) => [/^\s/.test(s), /\s$/.test(s)].join()
    for (const [lang, catalog] of Object.entries(catalogs)) {
      for (const [key, text] of Object.entries(catalog)) {
        if (!text.trim()) bad.push(`${lang}:${key} (empty)`)
        else if (edges(text) !== edges(englishFor(key) ?? '')) bad.push(`${lang}:${key} (a space at the start or end that English doesn't have, or the other way round)`)
      }
    }
    expect(bad).toEqual([])
  })

  it('use the same {{variables}} and <tags> in every language', () => {
    const mismatched: string[] = []
    for (const lang of others) {
      for (const [key, text] of Object.entries(catalogs[lang])) {
        const english = englishFor(key)
        if (english === undefined) continue // the keys test reports it
        // A plural form may leave out {{count}} ("one message" vs "en ny"), but nothing else.
        const strip = (list: string[]) => (isPlural(key) ? list.filter((v) => v !== 'count') : list)
        if (JSON.stringify(strip(variables(english))) !== JSON.stringify(strip(variables(text)))) mismatched.push(`${lang}:${key}: vars`)
        if (JSON.stringify(tags(english)) !== JSON.stringify(tags(text))) mismatched.push(`${lang}:${key}: tags`)
      }
    }
    expect(mismatched).toEqual([])
  })

  it('keep {{count}} in `_one` where that form is used for more than the number 1 (Russian 21, French 0)', () => {
    const missing: string[] = []
    for (const lang of others.filter((code) => !oneMeansOne(code))) {
      for (const [key, text] of Object.entries(catalogs[lang])) {
        if (key.endsWith('_one') && variables(source[`${baseOf(key)}_other`] ?? '').includes('count') && !variables(text).includes('count')) missing.push(`${lang}:${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('use no i18next nesting ($t), which English does not use either', () => {
    const bad: string[] = []
    for (const [lang, catalog] of Object.entries(catalogs)) {
      for (const [key, text] of Object.entries(catalog)) if (text.includes('$t(')) bad.push(`${lang}:${key}`)
    }
    expect(bad).toEqual([])
  })

  it('keep the name Iskra as it is', () => {
    const lost: string[] = []
    for (const lang of others) {
      for (const [key, text] of Object.entries(catalogs[lang])) {
        if ((englishFor(key) ?? '').includes('Iskra') && !text.includes('Iskra')) lost.push(`${lang}:${key}`)
      }
    }
    expect(lost).toEqual([])
  })

  it("don't name <Trans> tags after void HTML elements (their content would vanish)", () => {
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
    const bad = Object.entries(source).filter(([, text]) => tags(text).some((tag) => VOID.has(tag.replace('/', '')))).map(([key]) => key)
    expect(bad).toEqual([])
  })

  it('pick the right plural form in every language', () => {
    const bases = pluralBases(source)
    const wrong: string[] = []
    for (const lng of LANGUAGES) {
      const rules = new Intl.PluralRules(lng)
      const catalog = catalogs[lng]
      for (const base of bases) {
        for (const count of [0, 1, 2, 5, 21, 22, 100, 1.5]) {
          const text = catalog[`${base}_${rules.select(count)}`] ?? catalog[`${base}_other`]
          const shown = i18next.t(base as never, { lng, count }) as string
          if (shown !== i18next.services.interpolator.interpolate(text, { count }, lng, {})) wrong.push(`${lng}:${base} (${count})`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})

describe('plural rules', () => {
  it('need one/other in most languages and one/few/many/other in Russian and Polish', () => {
    for (const lang of ['en', 'sv', 'de', 'es', 'fr', 'it', 'pt']) expect(requiredPluralForms(lang), lang).toEqual(['one', 'other'])
    for (const lang of ['ru', 'pl']) expect(requiredPluralForms(lang), lang).toEqual(['one', 'few', 'many', 'other'])
    // Newer browsers ask for `many` at a million in these; a catalog may leave it out (it is filled from `other`).
    for (const lang of ['es', 'fr', 'it', 'pt']) expect(pluralForms(lang).filter((f) => f !== 'many'), lang).toEqual(['one', 'other'])
    for (const lang of ['en', 'sv', 'de']) expect(pluralForms(lang), lang).toEqual(['one', 'other'])
    // Where `one` is only the number 1, its text may leave out {{count}}.
    for (const lang of ['en', 'sv', 'de', 'es', 'it', 'pl']) expect(oneMeansOne(lang), lang).toBe(true)
    for (const lang of ['ru', 'fr', 'pt']) expect(oneMeansOne(lang), lang).toBe(false)
  })

  // Languages that aren't registered, on their own i18next with the app's options.
  async function instance(resources: Record<string, Tree>, fill: boolean) {
    const made = i18nextLibrary.createInstance()
    await made.init({
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
      resources: Object.fromEntries(Object.entries(resources).map(([lng, tree]) => [lng, { translation: fill ? withPluralForms(tree, lng) : tree }])),
    })
    return (lng: string, count: number) => (made.t as unknown as (key: string, options: object) => string)('files', { lng, count })
  }
  const TEXTS = {
    en: { files_one: '{{count}} file', files_other: '{{count}} files' },
    ru: { files_one: '{{count}} файл', files_few: '{{count}} файла', files_many: '{{count}} файлов', files_other: '{{count}} файла' },
    pl: { files_one: '{{count}} plik', files_few: '{{count}} pliki', files_many: '{{count}} plików', files_other: '{{count}} pliku' },
    es: { files_one: '{{count}} archivo', files_other: '{{count}} archivos' },
  }

  it('pick the Russian and Polish forms by number', async () => {
    const say = await instance(TEXTS, true)
    expect([1, 2, 5, 11, 21, 22, 25, 101, 1.5].map((n) => say('ru', n))).toEqual([
      '1 файл', '2 файла', '5 файлов', '11 файлов', '21 файл', '22 файла', '25 файлов', '101 файл', '1.5 файла',
    ])
    expect([1, 2, 5, 12, 21, 22, 25, 102, 1.5].map((n) => say('pl', n))).toEqual([
      '1 plik', '2 pliki', '5 plików', '12 plików', '21 plików', '22 pliki', '25 plików', '102 pliki', '1.5 pliku',
    ])
  })

  it("show the language's own `other` for a form its catalog leaves out, where i18next alone shows English", async () => {
    const million = 1_000_000
    const asks = new Intl.PluralRules('es').select(million) // "many" with newer language data, "other" before
    const bare = await instance(TEXTS, false)
    expect(bare('es', million)).toBe(asks === 'many' ? '1000000 files' : '1000000 archivos')
    const filled = await instance(TEXTS, true)
    expect(filled('es', million)).toBe('1000000 archivos')
    expect(filled('es', 1)).toBe('1 archivo')
    // Russian without `_few` and `_many`: its own `_other`, never English.
    const partial = await instance({ en: TEXTS.en, ru: { files_one: '{{count}} файл', files_other: '{{count}} файла' } }, true)
    expect(partial('ru', 3)).toBe('3 файла')
    expect(partial('ru', 5)).toBe('5 файла')
  })

  it('fill nested catalogs without changing the original', () => {
    const tree = { chat: { n_one: 'a', n_other: 'b', plain: 'c' } }
    const filled = withPluralForms(tree, 'ru') as { chat: Record<string, string> }
    expect(filled.chat).toEqual({ n_one: 'a', n_other: 'b', plain: 'c', n_few: 'b', n_many: 'b' })
    expect(Object.keys(tree.chat)).toEqual(['n_one', 'n_other', 'plain'])
  })
})

describe('language', () => {
  it('is English in tests', () => {
    expect(i18next.language).toBe('en')
    expect(t('common.cancel')).toBe('Cancel')
  })

  it('follows the system: the first of its languages we ship, else English', () => {
    // "xx" and "yy" stand for languages the app doesn't have.
    expect(systemLanguage(['sv-SE', 'en-US'])).toBe('sv')
    expect(systemLanguage(['sv'])).toBe('sv')
    expect(systemLanguage(['xx-XX', 'sv-SE'])).toBe('sv')
    expect(systemLanguage(['xx-XX', 'yy-YY'])).toBe('en')
    expect(systemLanguage(['SV_se'])).toBe('sv')
    for (const language of SHIPPED_LANGUAGES) expect(systemLanguage([languageInfo(language).locale, 'en-US'])).toBe(language)
    expect(systemLanguage(['en-GB'])).toBe('en')
    expect(systemLanguage([])).toBe('en')
    expect(resolveLanguage('auto', ['sv-FI'])).toBe('sv')
    expect(resolveLanguage('en', ['sv-SE'])).toBe('en')
  })

  it('reads a saved choice, and anything else is automatic', () => {
    expect(loadLanguageChoice({ getItem: () => 'sv' })).toBe('sv')
    expect(loadLanguageChoice({ getItem: () => 'xx' })).toBe('auto')
    expect(loadLanguageChoice({ getItem: () => 'constructor' })).toBe('auto')
    for (const language of LANGUAGES) expect(loadLanguageChoice({ getItem: () => language })).toBe(language)
    expect(loadLanguageChoice({ getItem: () => null })).toBe('auto')
    expect(loadLanguageChoice({ getItem: () => { throw new Error('blocked') } })).toBe('auto')
  })

  it('formats with the browser locale when it matches the language', () => {
    expect(intlLocale('en', ['en-GB', 'sv-SE'])).toBe('en-GB')
    expect(intlLocale('sv', ['en-GB', 'sv-SE'])).toBe('sv-SE')
    expect(intlLocale('sv', ['en-US'])).toBe('sv-SE')
    expect(intlLocale('en', ['xx-XX'])).toBe('en-US')
    for (const language of LANGUAGES) expect(intlLocale(language, [])).toBe(languageInfo(language).locale)
  })

  it('formats sizes in the language', async () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
    await i18next.changeLanguage('sv')
    try {
      expect(formatBytes(1536)).toBe('1,5 KB')
      expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB')
    } finally {
      await i18next.changeLanguage('en')
    }
  })
})

describe('server errors', () => {
  it("show the server's English text in English", () => {
    expect(errorMessage(new RequestError('forbidden', "You can't manage AutoMod on this server.", 'automod.set'))).toBe("You can't manage AutoMod on this server.")
  })

  it('translate by request type and code, falling back to the code, then the English text', async () => {
    await i18next.changeLanguage('sv')
    try {
      expect(errorMessage(new RequestError('busy', "They're in another call.", 'call.start'))).toBe('De är i ett annat samtal.')
      expect(errorMessage(new RequestError('forbidden', "You can't do that.", 'role.update'))).toBe('Du har inte behörighet att göra det.')
      expect(errorMessage(new RequestError('bad_request', 'Channel names are 1–32 characters.', 'channel.create'))).toBe('Channel names are 1–32 characters.')
      expect(translatedError('rate_limited', 'forum.post.create')).toBe('För många nya inlägg. Försök igen om en minut.')
      expect(errorMessage(new Error('Plain'))).toBe('Plain')
      expect(errorMessage(null)).toBe('Något gick fel.')
    } finally {
      await i18next.changeLanguage('en')
    }
  })
})
