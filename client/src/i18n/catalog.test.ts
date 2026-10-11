import { describe, expect, it } from 'vitest'
import { en } from './en'
import { sv } from './sv'
import { i18next, intlLocale, loadLanguageChoice, resolveLanguage, systemLanguage, t } from '.'
import { errorMessage, translatedError } from './errors'
import { formatBytes } from './format'
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

const catalogs = { en: flatten(en), sv: flatten(sv) }
const PLURAL = /_(zero|one|two|few|many|other)$/

describe('catalogs', () => {
  it('have exactly the same keys', () => {
    const enKeys = Object.keys(catalogs.en).sort()
    const svKeys = Object.keys(catalogs.sv).sort()
    expect(svKeys.filter((k) => !catalogs.en[k] && catalogs.en[k] !== '')).toEqual([])
    expect(enKeys.filter((k) => catalogs.sv[k] === undefined)).toEqual([])
    expect(svKeys).toEqual(enKeys)
  })

  it('have no empty texts', () => {
    for (const [lang, catalog] of Object.entries(catalogs)) {
      const empty = Object.entries(catalog).filter(([, text]) => !text.trim()).map(([key]) => `${lang}:${key}`)
      expect(empty).toEqual([])
    }
  })

  it('use the same {{variables}} and <tags> in every language', () => {
    const mismatched: string[] = []
    for (const [key, text] of Object.entries(catalogs.en)) {
      const other = catalogs.sv[key] ?? ''
      // A plural form may leave out {{count}} ("one message" vs "en ny"), but nothing else.
      const strip = (list: string[]) => (PLURAL.test(key) ? list.filter((v) => v !== 'count') : list)
      if (JSON.stringify(strip(variables(text))) !== JSON.stringify(strip(variables(other)))) mismatched.push(`${key}: vars`)
      if (JSON.stringify(tags(text)) !== JSON.stringify(tags(other))) mismatched.push(`${key}: tags`)
    }
    expect(mismatched).toEqual([])
  })

  it("don't name <Trans> tags after void HTML elements (their content would vanish)", () => {
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
    const bad = Object.entries(catalogs.en).filter(([, text]) => tags(text).some((tag) => VOID.has(tag.replace('/', '')))).map(([key]) => key)
    expect(bad).toEqual([])
  })

  it('have every plural form each language needs', () => {
    const missing: string[] = []
    for (const [lang, catalog] of Object.entries(catalogs)) {
      const forms = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
      const bases = new Set(Object.keys(catalog).filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')))
      for (const base of bases) {
        for (const form of forms) if (catalog[`${base}_${form}`] === undefined) missing.push(`${lang}:${base}_${form}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('pick the right plural form in both languages', () => {
    const bases = [...new Set(Object.keys(catalogs.en).filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')))]
    for (const lng of ['en', 'sv'] as const) {
      for (const base of bases) {
        const one = i18next.t(base as never, { lng, count: 1 }) as string
        const many = i18next.t(base as never, { lng, count: 5 }) as string
        const catalog = catalogs[lng]
        expect(one).toBe(i18next.services.interpolator.interpolate(catalog[`${base}_one`], { count: 1 }, lng, {}))
        expect(many).toBe(i18next.services.interpolator.interpolate(catalog[`${base}_other`], { count: 5 }, lng, {}))
      }
    }
  })
})

describe('language', () => {
  it('is English in tests', () => {
    expect(i18next.language).toBe('en')
    expect(t('common.cancel')).toBe('Cancel')
  })

  it('follows the system: Swedish for Swedish, else English', () => {
    expect(systemLanguage(['sv-SE', 'en-US'])).toBe('sv')
    expect(systemLanguage(['sv'])).toBe('sv')
    expect(systemLanguage(['de-DE', 'sv-SE'])).toBe('sv')
    expect(systemLanguage(['de-DE', 'fr-FR'])).toBe('en')
    expect(systemLanguage(['en-GB'])).toBe('en')
    expect(systemLanguage([])).toBe('en')
    expect(resolveLanguage('auto', ['sv-FI'])).toBe('sv')
    expect(resolveLanguage('en', ['sv-SE'])).toBe('en')
  })

  it('reads a saved choice, and anything else is automatic', () => {
    expect(loadLanguageChoice({ getItem: () => 'sv' })).toBe('sv')
    expect(loadLanguageChoice({ getItem: () => 'xx' })).toBe('auto')
    expect(loadLanguageChoice({ getItem: () => null })).toBe('auto')
    expect(loadLanguageChoice({ getItem: () => { throw new Error('blocked') } })).toBe('auto')
  })

  it('formats with the browser locale when it matches the language', () => {
    expect(intlLocale('en', ['en-GB', 'sv-SE'])).toBe('en-GB')
    expect(intlLocale('sv', ['en-GB', 'sv-SE'])).toBe('sv-SE')
    expect(intlLocale('sv', ['en-US'])).toBe('sv-SE')
    expect(intlLocale('en', ['de-DE'])).toBe('en-US')
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
