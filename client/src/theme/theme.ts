// Themes: a small JSON file of colours, radius, avatar shape and fonts.
// Every value is checked against a strict pattern or allowlist and set one CSS variable at a time
// (style.setProperty), so a theme can never inject CSS of its own.
import { BUILT_IN_THEMES, DEFAULT_THEME_ID } from './themes'
import { t } from '../i18n'

export const COLOR_KEYS = [
  'bgSurface', 'bgDeep', 'bgBody', 'bgFloat', 'bgSidebar', 'bgSidebarHover', 'bgChat', 'bgHover', 'bgButton', 'bgBorder', 'bgActive',
  'textHeading', 'textNormal', 'textMuted', 'textSubtle', 'textFaint',
  'accent', 'accentHover', 'success', 'successHover', 'danger', 'dangerHover', 'warning', 'link',
  'statusOnline', 'statusAway', 'statusDnd',
  'mentionBg', 'warningBg', 'dangerBg', 'speakingGlow', 'accentSubtle', 'onAccent', 'mentionText',
] as const
export type ColorKey = (typeof COLOR_KEYS)[number]

export const BODY_FONTS = {
  inter: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', Nunito, 'Varela Round', 'Segoe UI', system-ui, sans-serif",
  serif: "'Iowan Old Style', Charter, Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
} as const
export const MONO_FONTS = {
  jetbrains: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
  system: "ui-monospace, Menlo, Consolas, 'Courier New', monospace",
} as const
export const AVATAR_SHAPES = { circle: '50%', rounded: '30%', square: '12%' } as const

export interface ThemeFile {
  meta: { name: string; desc?: string; scheme?: 'dark' | 'light' }
  colors: Partial<Record<ColorKey, string>>
  /** Base corner radius in px (0–24); everything else scales from it. */
  radius?: number
  avatarShape?: keyof typeof AVATAR_SHAPES
  fonts?: { body?: keyof typeof BODY_FONTS; mono?: keyof typeof MONO_FONTS }
}

/** Which CSS variable each colour drives, and what it falls back to when a theme leaves it out. */
const VARIABLES: { name: string; key: ColorKey; fallback: string }[] = [
  { name: '--bg', key: 'bgDeep', fallback: '#0b0b14' },
  { name: '--rail', key: 'bgSurface', fallback: 'var(--bg)' },
  { name: '--stage', key: 'bgBody', fallback: 'var(--bg)' },
  { name: '--sidebar', key: 'bgSidebar', fallback: '#10101c' },
  { name: '--sidebar-hover', key: 'bgSidebarHover', fallback: 'var(--surface-2)' },
  { name: '--surface', key: 'bgChat', fallback: '#141424' },
  { name: '--float', key: 'bgFloat', fallback: 'var(--surface-2)' },
  { name: '--surface-2', key: 'bgButton', fallback: '#1b1b30' },
  { name: '--hover', key: 'bgHover', fallback: 'var(--surface-3)' },
  { name: '--surface-3', key: 'bgActive', fallback: '#24243d' },
  { name: '--border', key: 'bgBorder', fallback: 'rgba(120, 100, 255, 0.14)' },
  { name: '--text-strong', key: 'textHeading', fallback: 'var(--text)' },
  { name: '--text', key: 'textNormal', fallback: '#e2e2f0' },
  { name: '--text-2', key: 'textMuted', fallback: '#b4b4cc' },
  { name: '--muted', key: 'textSubtle', fallback: '#8484a8' },
  { name: '--faint', key: 'textFaint', fallback: '#4b4b66' },
  { name: '--accent', key: 'accent', fallback: '#695bff' },
  { name: '--accent-strong', key: 'accentHover', fallback: 'var(--accent)' },
  { name: '--accent-2', key: 'link', fallback: '#00cfff' },
  { name: '--green', key: 'success', fallback: '#4ade80' },
  { name: '--green-strong', key: 'successHover', fallback: 'var(--green)' },
  { name: '--red', key: 'danger', fallback: '#f87171' },
  { name: '--danger-solid', key: 'danger', fallback: '#b91c1c' },
  { name: '--hangup', key: 'danger', fallback: '#dc2626' },
  { name: '--hangup-hover', key: 'dangerHover', fallback: 'var(--danger-solid)' },
  { name: '--amber', key: 'warning', fallback: '#fbbf24' },
  { name: '--online', key: 'statusOnline', fallback: 'var(--green)' },
  { name: '--away', key: 'statusAway', fallback: 'var(--amber)' },
  { name: '--dnd', key: 'statusDnd', fallback: 'var(--red)' },
  { name: '--mention-bg', key: 'mentionBg', fallback: 'color-mix(in srgb, var(--accent) 20%, transparent)' },
  { name: '--mention-text', key: 'mentionText', fallback: 'var(--text-strong)' },
  { name: '--warning-bg', key: 'warningBg', fallback: 'color-mix(in srgb, var(--amber) 10%, transparent)' },
  { name: '--danger-bg', key: 'dangerBg', fallback: 'color-mix(in srgb, var(--red) 12%, transparent)' },
  { name: '--speaking-glow', key: 'speakingGlow', fallback: 'transparent' },
  { name: '--accent-subtle', key: 'accentSubtle', fallback: 'color-mix(in srgb, var(--accent) 8%, transparent)' },
  { name: '--on-accent', key: 'onAccent', fallback: '#ffffff' },
]
const OTHER_VARIABLES = ['--radius', '--avatar-radius', '--font', '--mono', '--name-l']

// ── Validation ──────────────────────────────────────────────────────────────

export const MAX_THEME_CHARS = 16_000

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i

/** Returns the colour in a canonical form, or null if it isn't a plain colour. */
export function safeColor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null
  const text = value.trim().toLowerCase()
  if (text === 'transparent') return text
  if (HEX.test(text)) return text
  const rgb = RGB.exec(text)
  if (!rgb) return null
  const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number)
  if (r > 255 || g > 255 || b > 255) return null
  if (rgb[4] === undefined) return `rgb(${r}, ${g}, ${b})`
  const alpha = Number(rgb[4])
  if (!(alpha >= 0 && alpha <= 1)) return null
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

// Control and bidi/zero-width characters are exactly what this rejects.
// oxlint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/

const cleanText = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && !INVISIBLE.test(v) ? v.trim() : null

export type ThemeResult = { ok: true; theme: ThemeFile } | { ok: false; errors: string[] }

/** Strict: unknown keys and anything that isn't exactly the expected shape are errors. */
export function validateTheme(input: unknown): ThemeResult {
  const errors: string[] = []
  if (!isPlainObject(input)) return { ok: false, errors: [t('profile.theme.errors.notObject')] }
  for (const key of Object.keys(input)) {
    if (!['meta', 'colors', 'radius', 'avatarShape', 'fonts'].includes(key)) errors.push(t('profile.theme.errors.unknownKey', { key }))
  }

  const meta: ThemeFile['meta'] = { name: '' }
  if (!isPlainObject(input.meta)) errors.push(t('profile.theme.errors.meta'))
  else {
    for (const key of Object.keys(input.meta)) if (!['name', 'desc', 'scheme'].includes(key)) errors.push(t('profile.theme.errors.unknownKey', { key: `meta.${key}` }))
    const name = cleanText(input.meta.name, 40)
    if (name) meta.name = name
    else errors.push(t('profile.theme.errors.name'))
    if (input.meta.desc !== undefined) {
      const desc = cleanText(input.meta.desc, 120)
      if (desc) meta.desc = desc
      else errors.push(t('profile.theme.errors.desc'))
    }
    if (input.meta.scheme !== undefined) {
      if (input.meta.scheme === 'dark' || input.meta.scheme === 'light') meta.scheme = input.meta.scheme
      else errors.push(t('profile.theme.errors.scheme'))
    }
  }

  const colors: ThemeFile['colors'] = {}
  if (input.colors !== undefined && !isPlainObject(input.colors)) errors.push(t('profile.theme.errors.mustBeObject', { key: 'colors' }))
  else if (isPlainObject(input.colors)) {
    for (const [key, value] of Object.entries(input.colors)) {
      if (!(COLOR_KEYS as readonly string[]).includes(key)) {
        errors.push(t('profile.theme.errors.unknownColour', { key }))
        continue
      }
      const color = safeColor(value)
      if (color) colors[key as ColorKey] = color
      else errors.push(t('profile.theme.errors.colour', { key: `colors.${key}` }))
    }
  }

  const theme: ThemeFile = { meta, colors }
  if (input.radius !== undefined) {
    if (typeof input.radius === 'number' && Number.isInteger(input.radius) && input.radius >= 0 && input.radius <= 24) theme.radius = input.radius
    else errors.push(t('profile.theme.errors.radius'))
  }
  if (input.avatarShape !== undefined) {
    if (typeof input.avatarShape === 'string' && Object.hasOwn(AVATAR_SHAPES, input.avatarShape)) theme.avatarShape = input.avatarShape as ThemeFile['avatarShape']
    else errors.push(t('profile.theme.errors.oneOf', { key: 'avatarShape', values: Object.keys(AVATAR_SHAPES).join(', ') }))
  }
  if (input.fonts !== undefined) {
    if (!isPlainObject(input.fonts)) errors.push(t('profile.theme.errors.mustBeObject', { key: 'fonts' }))
    else {
      theme.fonts = {}
      for (const [key, value] of Object.entries(input.fonts)) {
        const table = key === 'body' ? BODY_FONTS : key === 'mono' ? MONO_FONTS : null
        if (!table) errors.push(t('profile.theme.errors.unknownKey', { key: `fonts.${key}` }))
        else if (typeof value === 'string' && Object.hasOwn(table, value)) (theme.fonts as Record<string, string>)[key] = value
        else errors.push(t('profile.theme.errors.oneOf', { key: `fonts.${key}`, values: Object.keys(table).join(', ') }))
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, theme }
}

export function parseTheme(text: string): ThemeResult {
  if (text.length > MAX_THEME_CHARS) return { ok: false, errors: [t('profile.theme.errors.tooLong', { max: MAX_THEME_CHARS })] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [t('profile.theme.errors.json', { message: (e as Error).message })] }
  }
  return validateTheme(parsed)
}

// ── Contrast ────────────────────────────────────────────────────────────────

function rgbOf(color: string): [number, number, number] | null {
  if (color.startsWith('#')) {
    const hex = color.length <= 5 ? [...color.slice(1, 4)].map((c) => c + c).join('') : color.slice(1, 7)
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
  }
  const m = RGB.exec(color)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Contrast ratio of two colours (WCAG), 1 to 21. */
export function contrast(a: string, b: string): number {
  const x = rgbOf(a)
  const y = rgbOf(b)
  if (!x || !y) return 1
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

/** White or near-black text for the given background colour. */
export function textOn(color: string): string {
  const rgb = rgbOf(color)
  if (!rgb) return '#ffffff'
  // White when it reads at 4.5:1 (WCAG AA), otherwise whichever reads better.
  return contrast('#ffffff', color) >= 4.5 || contrast('#ffffff', color) >= contrast('#0b0b14', color) ? '#ffffff' : '#0b0b14'
}

/** An `hsl(h s% l%)` colour as #rrggbb. */
function hslHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** How light author names (hsl(hue 70% L)) must be to read at 4.5:1 on a dark chat background, whatever the hue. */
export function nameLightness(background: string): number {
  for (let l = 72; l < 96; l++) {
    let ok = true
    for (let h = 0; h < 360 && ok; h += 15) ok = contrast(hslHex(h, 70, l), background) >= 4.5
    if (ok) return l
  }
  return 96
}

/** The colour, darkened just enough for white text on it to read at 4.5:1 (danger buttons). */
export function solidUnderWhite(color: string): string {
  const rgb = rgbOf(color)
  if (!rgb) return color
  for (let f = 1; f > 0.2; f -= 0.02) {
    const hex = `#${rgb.map((c) => Math.round(c * f).toString(16).padStart(2, '0')).join('')}`
    if (contrast('#ffffff', hex) >= 4.5) return hex
  }
  return '#000000'
}

function hslOf([r, g, b]: [number, number, number]): [number, number, number] {
  const [x, y, z] = [r / 255, g / 255, b / 255]
  const max = Math.max(x, y, z)
  const min = Math.min(x, y, z)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === x ? (y - z) / d + (y < z ? 6 : 0) : max === y ? (z - x) / d + 2 : (x - y) / d + 4
  return [h * 60, s * 100, l * 100]
}

const readableCache = new Map<string, string>()

/**
 * A colour chosen by someone else (a role colour) as text that reads at 4.5:1 on every one of `backgrounds`:
 * the same hue and saturation, lighter on dark themes and darker on light ones. Unchanged when it already reads.
 */
export function readableColor(color: string, backgrounds: readonly string[], min = 4.5): string {
  const key = `${color}|${backgrounds.join(',')}|${min}`
  const hit = readableCache.get(key)
  if (hit) return hit
  const rgb = rgbOf(color)
  const bgs = backgrounds.filter((b) => rgbOf(b))
  let out = color
  if (rgb && bgs.length && !bgs.every((b) => contrast(color, b) >= min)) {
    const [h, s, l0] = hslOf(rgb)
    const dark = bgs.reduce((n, b) => n + luminance(rgbOf(b)!), 0) / bgs.length < 0.18
    out = dark ? '#ffffff' : '#000000'
    for (let l = Math.round(l0); dark ? l <= 100 : l >= 0; l += dark ? 1 : -1) {
      const candidate = hslHex(h, s, l)
      if (bgs.every((b) => contrast(candidate, b) >= min)) {
        out = candidate
        break
      }
    }
  }
  if (readableCache.size > 500) readableCache.clear()
  readableCache.set(key, out)
  return out
}

/** The backgrounds names sit on in the current theme: chat, sidebar (member list) and popovers. */
export const DEFAULT_NAME_SURFACES = ['#141424', '#10101c', '#1b1b30'] as const
let nameSurfaces: readonly string[] = DEFAULT_NAME_SURFACES
const surfaceListeners = new Set<() => void>()
export const getNameSurfaces = () => nameSurfaces
export function onNameSurfaces(listener: () => void): () => void {
  surfaceListeners.add(listener)
  return () => surfaceListeners.delete(listener)
}
export function nameSurfacesOf(theme: ThemeFile | null): readonly string[] {
  if (!theme) return DEFAULT_NAME_SURFACES
  const c = theme.colors
  return [c.bgChat ?? DEFAULT_NAME_SURFACES[0], c.bgSidebar ?? DEFAULT_NAME_SURFACES[1], c.bgFloat ?? c.bgButton ?? DEFAULT_NAME_SURFACES[2]]
}

// ── Applying ────────────────────────────────────────────────────────────────

/** The CSS variables a theme sets (null for the default, which is plain styles.css). */
export function themeVariables(theme: ThemeFile): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const { name, key, fallback } of VARIABLES) vars[name] = theme.colors[key] ?? fallback
  if (!theme.colors.onAccent && theme.colors.accent) vars['--on-accent'] = textOn(theme.colors.accent)
  if (theme.colors.danger) vars['--danger-solid'] = solidUnderWhite(theme.colors.danger)
  // Light themes keep the stylesheet's dark names.
  if (theme.meta.scheme !== 'light' && theme.colors.bgChat) vars['--name-l'] = `${nameLightness(theme.colors.bgChat)}%`
  vars['--radius'] = `${theme.radius ?? 10}px`
  vars['--avatar-radius'] = AVATAR_SHAPES[theme.avatarShape ?? 'circle']
  vars['--font'] = BODY_FONTS[theme.fonts?.body ?? 'inter']
  vars['--mono'] = MONO_FONTS[theme.fonts?.mono ?? 'jetbrains']
  return vars
}

export function applyTheme(theme: ThemeFile | null, root: HTMLElement = document.documentElement): void {
  for (const { name } of VARIABLES) root.style.removeProperty(name)
  for (const name of OTHER_VARIABLES) root.style.removeProperty(name)
  root.style.removeProperty('color-scheme')
  // Lets the stylesheet adjust what can't be a theme colour (name colours, shadows) for light themes.
  root.dataset.scheme = theme?.meta.scheme ?? 'dark'
  const surfaces = nameSurfacesOf(theme)
  if (surfaces.join() !== nameSurfaces.join()) {
    nameSurfaces = surfaces
    for (const listener of surfaceListeners) listener()
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme?.colors.bgDeep ?? '#0b0b14')
  if (!theme) return
  for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value)
  root.style.setProperty('color-scheme', theme.meta.scheme ?? 'dark')
}

// ── Choosing and saving ─────────────────────────────────────────────────────

export type ThemeChoice = { id: string } | { custom: ThemeFile }

const STORAGE_KEY = 'iskra.theme'

export function themeFor(choice: ThemeChoice): ThemeFile | null {
  if ('custom' in choice) return choice.custom
  if (choice.id === DEFAULT_THEME_ID) return null
  return BUILT_IN_THEMES.find((t) => t.id === choice.id)?.theme ?? null
}

/** What's saved, re-checked (storage is never trusted). Falls back to the default. */
export function loadThemeChoice(storage: Pick<Storage, 'getItem'> = localStorage): ThemeChoice {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as unknown
    if (isPlainObject(saved) && typeof saved.id === 'string' && BUILT_IN_THEMES.some((t) => t.id === saved.id)) return { id: saved.id }
    if (isPlainObject(saved) && 'custom' in saved) {
      const result = validateTheme(saved.custom)
      if (result.ok) return { custom: result.theme }
    }
  } catch {
    /* corrupt or blocked storage: default theme */
  }
  return { id: DEFAULT_THEME_ID }
}

export function saveThemeChoice(choice: ThemeChoice, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(choice))
  } catch {
    /* private mode: the theme just won't stick */
  }
}

export function chooseTheme(choice: ThemeChoice): void {
  applyTheme(themeFor(choice))
  saveThemeChoice(choice)
}

/** Called once before the first render, so there's no flash of the default look. */
export function applySavedTheme(): void {
  applyTheme(themeFor(loadThemeChoice()))
}
