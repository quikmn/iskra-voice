import { describe, expect, it } from 'vitest'
import { BODY_FONTS, DEFAULT_FONT_PREFS, effectiveFonts, fontVariables, loadFontPrefs, MONO_FONTS, saveFontPrefs } from './fonts'
import { validateTheme, type ThemeFile } from './theme'
import { BUILT_IN_THEMES } from './themes'

const stored = (value: string | null) => ({ getItem: () => value })

describe('font settings', () => {
  it('start at Inter, JetBrains Mono and theme fonts on, whatever theme someone had before', () => {
    // Nothing saved: everyone before fonts were their own setting, including people on Graphite, Solarized,
    // Synthwave or Cyber-Lime (which used to set a font).
    expect(loadFontPrefs(stored(null))).toEqual({ body: 'inter', mono: 'jetbrains', useThemeFont: true })
    expect(DEFAULT_FONT_PREFS).toEqual({ body: 'inter', mono: 'jetbrains', useThemeFont: true })
  })

  it('never trust what is saved: bad values fall back one by one', () => {
    expect(loadFontPrefs(stored('{"body":"rounded","mono":"system","useThemeFont":false}'))).toEqual({ body: 'rounded', mono: 'system', useThemeFont: false })
    expect(loadFontPrefs(stored('{"body":"Comic Sans","mono":"toString","useThemeFont":"yes"}'))).toEqual(DEFAULT_FONT_PREFS)
    expect(loadFontPrefs(stored('{"body":"__proto__"}'))).toEqual(DEFAULT_FONT_PREFS)
    expect(loadFontPrefs(stored('{"body":"serif"}'))).toEqual({ ...DEFAULT_FONT_PREFS, body: 'serif' })
    expect(loadFontPrefs(stored('garbage'))).toEqual(DEFAULT_FONT_PREFS)
    expect(loadFontPrefs(stored('[1,2]'))).toEqual(DEFAULT_FONT_PREFS)
    expect(loadFontPrefs({ getItem: () => { throw new Error('blocked') } })).toEqual(DEFAULT_FONT_PREFS)
  })

  it('save only the three known fields', () => {
    let saved = ''
    saveFontPrefs({ body: 'mono', mono: 'system', useThemeFont: false, extra: 'x' } as never, { setItem: (_k, v) => { saved = v } })
    expect(JSON.parse(saved)).toEqual({ body: 'mono', mono: 'system', useThemeFont: false })
  })
})

describe('the font in use', () => {
  const named: ThemeFile = { meta: { name: 'Nord Plus' }, colors: {}, fonts: { body: 'rounded', mono: 'system' } }
  const mine = { body: 'serif', mono: 'jetbrains', useThemeFont: true } as const

  it('switching between built-in themes never changes it', () => {
    for (const { id, theme } of BUILT_IN_THEMES) {
      expect(theme.fonts, id).toBeUndefined()
      expect(effectiveFonts(theme, mine), id).toEqual({ body: 'serif', mono: 'jetbrains', fromTheme: { body: false, mono: false } })
    }
  })

  it("is the theme's when it names one and the person allows it", () => {
    expect(effectiveFonts(named, mine)).toEqual({ body: 'rounded', mono: 'system', fromTheme: { body: true, mono: true } })
    expect(effectiveFonts({ ...named, fonts: { body: 'mono' } }, mine)).toEqual({ body: 'mono', mono: 'jetbrains', fromTheme: { body: true, mono: false } })
  })

  it("is the person's when the box is off", () => {
    expect(effectiveFonts(named, { ...mine, useThemeFont: false })).toEqual({ body: 'serif', mono: 'jetbrains', fromTheme: { body: false, mono: false } })
    expect(effectiveFonts(null, mine).body).toBe('serif')
  })

  it('only ever sets a fixed font stack', () => {
    expect(fontVariables({ body: 'rounded', mono: 'system' })).toEqual({ '--font': BODY_FONTS.rounded, '--mono': MONO_FONTS.system })
    expect(BODY_FONTS.inter.startsWith('Inter,')).toBe(true)
    expect(BODY_FONTS.rounded.startsWith('Nunito,')).toBe(true)
    // A theme file can only name a font from the list.
    expect(validateTheme({ meta: { name: 'x' }, colors: {}, fonts: { body: 'rounded', mono: 'system' } }).ok).toBe(true)
    expect(validateTheme({ meta: { name: 'x' }, colors: {}, fonts: { body: "x'; } body { color: red" } }).ok).toBe(false)
    const sneaky = { meta: { name: 'x' }, colors: {}, fonts: { body: 'constructor' } } as unknown as ThemeFile
    expect(effectiveFonts(sneaky, mine).body).toBe('serif')
  })
})
