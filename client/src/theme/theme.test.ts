import { describe, expect, it } from 'vitest'
import { codeColors, contrast, contrastIssues, effectiveColor, INPUT_BACKGROUNDS, placeholderColor, loadThemeChoice, nameLightness, nameSurfacesOf, readableColor, parseTheme, safeColor, solidUnderWhite, textOn, themeVariables, validateTheme } from './theme'
import { BUILT_IN_THEMES } from './themes'
import type { ThemeFile } from './theme'

/** hsl(h 70% l) as #rrggbb, like the stylesheet's author names. */
function hslOf70(h: number, l: number): string {
  const a = 0.7 * Math.min(l / 100, 1 - l / 100)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round((l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

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
    // "Iskra Dark" (id "default") became Graphite: people who picked it keep it.
    expect(loadThemeChoice(stored('{"id":"default"}'))).toEqual({ id: 'graphite' })
    expect(loadThemeChoice(stored('{"id":"__proto__"}'))).toEqual({ id: 'iskra' })
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

  it('makes author names readable on every name surface, a hovered message too', () => {
    // The stylesheet's default (--name-l: 72%) is what no theme gets.
    expect(nameLightness(nameSurfacesOf(null))).toBeLessThanOrEqual(72)
    for (const theme of [null, ...BUILT_IN_THEMES.map((t) => t.theme), { meta: { name: 'Daylight', scheme: 'light' }, colors: { bgChat: '#ffffff', bgSidebar: '#f2f3f5', bgFloat: '#ffffff', textNormal: '#2e3338' } } as ThemeFile]) {
      const surfaces = nameSurfacesOf(theme)
      const l = nameLightness(surfaces)
      for (let h = 0; h < 360; h += 15) for (const s of surfaces) expect(contrast(hslOf70(h, l), s), `${theme?.meta.name} h${h} on ${s}`).toBeGreaterThanOrEqual(4.5)
    }
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

  it('includes a hovered message, so a name stays readable under the mouse', () => {
    const graphite = BUILT_IN_THEMES.find((t) => t.theme.meta.name === 'Graphite')!.theme
    // What CI's axe run saw: the owner colour on a hovered message read 4.3:1.
    expect(nameSurfacesOf(graphite)).toContain('#36383d')
    expect(contrast(readableColor('#9793ec', nameSurfacesOf(graphite)), '#36383d')).toBeGreaterThanOrEqual(4.5)
  })

  it('ignores what it cannot read', () => {
    expect(readableColor('nonsense', ['#141424'])).toBe('nonsense')
    expect(readableColor('#123456', ['transparent'])).toBe('#123456')
  })
})

describe('input placeholders', () => {
  const custom = { meta: { name: 'Light' }, colors: { bgDeep: '#ffffff', bgChat: '#f6f6f8', bgFloat: '#ffffff', bgButton: '#eeeef2', textNormal: '#1a1a1a', textSubtle: '#55555f' } }
  const looks = [...BUILT_IN_THEMES.map((b) => b.theme), { meta: { name: 'Default' }, colors: {} }, custom]

  it('are visibly dimmer than typed text yet stay at 4.5:1 in every theme', () => {
    for (const theme of looks) {
      const text = effectiveColor(theme, 'textNormal')
      const bgs = INPUT_BACKGROUNDS.map((k) => effectiveColor(theme, k))
      const placeholder = themeVariables(theme)['--placeholder']
      const worst = (c: string) => Math.min(...bgs.map((b) => contrast(c, b)))
      expect(worst(placeholder), theme.meta.name).toBeGreaterThanOrEqual(4.5)
      // Dimmer wherever the text leaves room above 4.5.
      if (worst(text) >= 4.5 / 0.55) expect(worst(placeholder) / worst(text), theme.meta.name).toBeLessThanOrEqual(0.6)
      expect(placeholder, theme.meta.name).not.toBe(text)
    }
  })

  it('keeps text that is already at the limit as it is', () => {
    expect(placeholderColor('#777777', ['#ffffff'])).toBe('#777777')
    expect(placeholderColor('#ffffff', ['#000000'], '#888888')).toBe('#888888') // the theme's own grey fits
    expect(placeholderColor('#ffffff', ['#000000'], '#222222')).not.toBe('#222222') // too dim to read
    expect(placeholderColor('nope', ['#ffffff'])).toBe('nope')
  })
})

describe('contrast warnings for custom themes', () => {
  it('finds nothing in the built-in themes', () => {
    for (const { theme } of BUILT_IN_THEMES) expect(contrastIssues(theme), theme.meta.name).toEqual([])
  })

  it('flags low-contrast text with its ratio and a fix that reads', () => {
    const theme = { meta: { name: 'Murky' }, colors: { bgChat: '#202020', textMuted: '#444444' } }
    const issues = contrastIssues(theme)
    const chat = issues.find((i) => i.text === 'textMuted' && i.background === 'bgChat')!
    expect(chat.ratio).toBeLessThan(4.5)
    expect(chat.ratio).toBeCloseTo(contrast('#444444', '#202020'), 1)
    expect(contrast(chat.fix, '#202020')).toBeGreaterThanOrEqual(4.5)
    // Applying the fixes clears the warnings.
    const fixed = { ...theme, colors: { ...theme.colors, ...Object.fromEntries(issues.map((i) => [i.text, i.fix])) } }
    expect(contrastIssues(fixed)).toEqual([])
  })

  it('follows fallbacks and skips pairs the theme leaves to the defaults', () => {
    expect(effectiveColor({ meta: { name: 'x' }, colors: { textNormal: '#123456' } }, 'textHeading')).toBe('#123456')
    expect(contrastIssues({ meta: { name: 'x' }, colors: { accent: '#ffff00' } })).toEqual([])
    expect(contrastIssues({ meta: { name: 'x' }, colors: { accent: '#ffff00', onAccent: '#ffffff' } }).map((i) => i.text)).toEqual(['onAccent'])
  })
})

// Syntax colours in code blocks: every one reads at AA on the code background in every built-in look and the default.
describe('code colours', () => {
  it.each([...BUILT_IN_THEMES.map(({ id, theme }) => [id, theme] as const), ['default (no theme)', null] as const])('%s reads at AA', (_id, theme) => {
    const background = theme?.colors.bgDeep ?? '#0b0b14'
    const colors = codeColors(theme)
    expect(Object.keys(colors).length).toBeGreaterThanOrEqual(7)
    for (const [name, color] of Object.entries(colors)) expect(contrast(color, background), `${name} ${color} on ${background}`).toBeGreaterThanOrEqual(4.5)
  })
})
