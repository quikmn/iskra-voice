import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LANGUAGE_NAMES, SHIPPED_LANGUAGES } from '../../i18n'
import { LANGUAGE_REGISTRY } from '../../i18n/languages'
import { LanguageSection, pickerLanguages } from './LanguageSection'

describe('My settings → Language', () => {
  it('offers Automatic, then every shipped language under its own name, marked with its language', () => {
    const html = renderToStaticMarkup(<LanguageSection />)
    const picker = /<select[^>]*aria-label="Language"[^>]*>(.*?)<\/select>/s.exec(html)![1]
    const options = [...picker.matchAll(/<option value="([^"]+)"(?: lang="([^"]+)")?[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2], m[3]])
    expect(options).toEqual([['auto', undefined, 'Automatic (system language)'], ...SHIPPED_LANGUAGES.map((code) => [code, code, LANGUAGE_NAMES[code]])])
    expect(options.map((o) => o[0])).toContain('sv')
  })

  it('lists the languages by name, and only the shipped ones', () => {
    const names = SHIPPED_LANGUAGES.map((code) => LANGUAGE_NAMES[code])
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')))
    expect([...SHIPPED_LANGUAGES].sort()).toEqual(LANGUAGE_REGISTRY.filter((l) => l.shipped).map((l) => l.code).sort())
    expect(pickerLanguages('auto')).toEqual(SHIPPED_LANGUAGES)
    expect(pickerLanguages('sv')).toEqual(SHIPPED_LANGUAGES)
  })
})
