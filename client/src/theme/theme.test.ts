import { describe, expect, it } from 'vitest'
import { loadThemeChoice, parseTheme, safeColor, textOn, themeVariables, validateTheme } from './theme'
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
    expect(textOn('#7c6fff')).toBe('#ffffff')
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
