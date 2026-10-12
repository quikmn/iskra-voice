import { describe, expect, it } from 'vitest'
import { contrast, loadThemeChoice, nameLightness, nameSurfacesOf, readableColor, parseTheme, safeColor, solidUnderWhite, textOn, themeVariables, validateTheme } from './theme'
import { BUILT_IN_THEMES } from './themes'

const valid = { meta: { name: 'Mine' }, colors: { accent: '#ff8800' } }

describe('theme validation', () => {
  it('accepts every built-in look', () => {
    expect(BUILT_IN_THEMES).toHaveLength(11)
    for (const { theme } of BUILT_IN_THEMES) expect(validateTheme(theme).ok).toBe(true)
  })

  it('accepts plain colours in canonical form', () => {
    expect(safeColor('#ABC')).toBe('#abc')
    expect(safeColor('rgba(255, 0, 127, 0.25)')).toBe('rgba(255, 0, 127, 0.25)')
    expect(safeColor('rgb(1,2,3)')).toBe('rgb(1, 2, 3)')
    expect(safeColor('transparent')).toBe('transparent')
  })

  it.each([
    'red; background: url(https://evil.example/x)',
    'url(https://evil.example/track.png)',
    'var(--accent)',
    'expression(alert(1))',
    '#12345',
    'rgb(256, 0, 0)',
    'rgba(1, 2, 3, 2)',
    'rgba(1, 2, 3, 0.5) !important',
    '#fff}body{display:none',
    'image-set("x.png" 1x)',
    '\\23 fff',
    '',
  ])('rejects the colour %j', (color) => {
    expect(safeColor(color)).toBeNull()
    const result = validateTheme({ meta: { name: 'Bad' }, colors: { accent: color } })
    expect(result.ok).toBe(false)
  })

  it('rejects unknown keys anywhere', () => {
    expect(validateTheme({ ...valid, css: 'body { display: none }' }).ok).toBe(false)
    expect(validateTheme({ meta: { name: 'x', author: 'me' }, colors: {} }).ok).toBe(false)
    expect(validateTheme({ meta: { name: 'x' }, colors: { 'background-image': '#fff' } }).ok).toBe(false)
    expect(validateTheme({ meta: { name: 'x' }, colors: {}, fonts: { body: 'inter', heading: 'serif' } }).ok).toBe(false)
    expect(parseTheme('{"meta":{"name":"x"},"colors":{},"__proto__":{"polluted":true}}').ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('only allows listed fonts, shapes and sane radii', () => {
    expect(validateTheme({ ...valid, fonts: { body: "Comic Sans'; } * { color: red" } }).ok).toBe(false)
    expect(validateTheme({ ...valid, fonts: { body: 'toString' } }).ok).toBe(false)
    expect(validateTheme({ ...valid, avatarShape: 'hexagon' }).ok).toBe(false)
    expect(validateTheme({ ...valid, radius: 999 }).ok).toBe(false)
    expect(validateTheme({ ...valid, radius: '10px' }).ok).toBe(false)
    expect(validateTheme({ ...valid, radius: 1.5 }).ok).toBe(false)
    expect(validateTheme({ ...valid, radius: 0, avatarShape: 'square', fonts: { body: 'serif', mono: 'system' } }).ok).toBe(true)
  })

  it('needs a short, visible name', () => {
    expect(validateTheme({ meta: {}, colors: {} }).ok).toBe(false)
    expect(validateTheme({ meta: { name: 'x'.repeat(41) }, colors: {} }).ok).toBe(false)
    expect(validateTheme({ meta: { name: 'evil\u202Eeman' }, colors: {} }).ok).toBe(false)
    expect(validateTheme({ meta: { name: 'Fine', scheme: 'sepia' }, colors: {} }).ok).toBe(false)
  })

  it('reports bad JSON and huge files without throwing', () => {
    expect(parseTheme('{nope').ok).toBe(false)
    expect(parseTheme('[]').ok).toBe(false)
    expect(parseTheme(' '.repeat(20_000)).ok).toBe(false)
    expect(parseTheme(JSON.stringify(valid))).toEqual({ ok: true, theme: valid })
  })
})

describe('applying themes', () => {
  it('fills every variable, with readable text on the accent', () => {
    const vars = themeVariables({ meta: { name: 'Lime' }, colors: { accent: '#39ff14' }, radius: 4 })
    expect(vars['--accent']).toBe('#39ff14')
    expect(vars['--on-accent']).toBe('#0b0b14')
    expect(vars['--bg']).toBe('#0b0b14')
    expect(vars['--radius']).toBe('4px')
    expect(vars['--avatar-radius']).toBe('50%')
    expect(textOn('#695bff')).toBe('#ffffff')
    expect(textOn('#7c6fff')).toBe('#0b0b14') // white is only 3.8:1 there
    for (const value of Object.values(vars)) expect(value).not.toMatch(/[;{}]/)
  })

  it('never trusts what is saved', () => {
    const stored = (value: string) => ({ getItem: () => value })
    expect(loadThemeChoice(stored('{"id":"nord"}'))).toEqual({ id: 'nord' })
    expect(loadThemeChoice(stored('{"id":"made-up"}'))).toEqual({ id: 'iskra' })
    expect(loadThemeChoice(stored('{"custom":{"meta":{"name":"x"},"colors":{"bgDeep":"url(x)"}}}'))).toEqual({ id: 'iskra' })
    expect(loadThemeChoice(stored('garbage'))).toEqual({ id: 'iskra' })
    expect(loadThemeChoice(stored(JSON.stringify({ custom: valid })))).toEqual({ custom: valid })
  })
})

// WCAG AA in every built-in look: 4.5:1 for text on the surfaces it sits on, white on danger buttons.
describe('contrast', () => {
  const surfaces = ['bgChat', 'bgSidebar', 'bgFloat', 'bgDeep'] as const
  for (const { id, theme } of BUILT_IN_THEMES) {
    it(`${id} reads at AA`, () => {
      const vars = themeVariables(theme)
      const c = theme.colors
      const low: string[] = []
      const check = (fg: string | undefined, bg: string | undefined, what: string) => {
        if (fg && bg && contrast(fg, bg) < 4.5) low.push(`${what} ${contrast(fg, bg).toFixed(2)}`)
      }
      for (const s of surfaces) {
        for (const t of ['textHeading', 'textNormal', 'textMuted', 'textSubtle', 'link', 'danger', 'success', 'warning', 'mentionText'] as const) check(c[t], c[s], `${t} on ${s}`)
      }
      for (const t of ['textNormal', 'textMuted', 'link'] as const) check(c[t], c.bgButton, `${t} on bgButton`)
      check(c.textNormal, c.bgActive, 'textNormal on bgActive')
      check(vars['--on-accent'], vars['--accent'], 'onAccent on accent')
      check('#ffffff', vars['--danger-solid'], 'white on danger-solid')
      expect(low).toEqual([])
    })
  }

  it('makes author names light enough on every dark chat background', () => {
    expect(nameLightness('#141424')).toBe(72)
    expect(nameLightness('#3b4252')).toBeGreaterThan(72)
  })

  it('darkens a colour just enough for white text', () => {
    expect(contrast('#ffffff', solidUnderWhite('#f87171'))).toBeGreaterThanOrEqual(4.5)
    expect(solidUnderWhite('#b91c1c')).toBe('#b91c1c')
  })
})

describe('readable role colours', () => {
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const max = Math.max(r, g, b)
    const d = max - Math.min(r, g, b)
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return (h * 60 + 360) % 360
  }

  it('leaves a colour that already reads alone', () => {
    expect(readableColor('#ffd166', ['#141424'])).toBe('#ffd166')
  })

  it('lightens a dark colour on a dark theme, keeping the hue', () => {
    const out = readableColor('#1e3a8a', ['#141424', '#10101c'])
    expect(out).not.toBe('#1e3a8a')
    expect(contrast(out, '#141424')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(out, '#10101c')).toBeGreaterThanOrEqual(4.5)
    expect(Math.abs(hue(out) - hue('#1e3a8a'))).toBeLessThan(4)
  })

  it('darkens a light colour on a light theme', () => {
    const out = readableColor('#facc15', ['#ffffff', '#f2f3f5'])
    expect(contrast(out, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(out, '#f2f3f5')).toBeGreaterThanOrEqual(4.5)
    expect(Math.abs(hue(out) - hue('#facc15'))).toBeLessThan(4)
  })

  it('reads on the name surfaces of every built-in theme', () => {
    const picks = ['#000000', '#ff0000', '#0000ff', '#5865f2', '#99aab5', '#2ecc71', '#ffffff', '#ffff00', '#800080']
    for (const { theme } of [{ theme: null }, ...BUILT_IN_THEMES]) {
      const surfaces = nameSurfacesOf(theme)
      for (const pick of picks) {
        const out = readableColor(pick, surfaces)
        for (const s of surfaces) expect(contrast(out, s), `${pick} on ${s}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('ignores what it cannot read', () => {
    expect(readableColor('nonsense', ['#141424'])).toBe('nonsense')
    expect(readableColor('#123456', ['transparent'])).toBe('#123456')
  })
})
