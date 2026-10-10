// Themes: a small JSON file of colours, radius, avatar shape and fonts.
// Every value is checked against a strict pattern or allowlist and set one CSS variable at a time
// (style.setProperty), so a theme can never inject CSS of its own.
import { BUILT_IN_THEMES, DEFAULT_THEME_ID } from './themes'

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
  { name: '--muted', key: 'textSubtle', fallback: '#7878a0' },
  { name: '--faint', key: 'textFaint', fallback: '#4b4b66' },
  { name: '--accent', key: 'accent', fallback: '#7c6fff' },
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
const OTHER_VARIABLES = ['--radius', '--avatar-radius', '--font', '--mono']

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
  if (!isPlainObject(input)) return { ok: false, errors: ['A theme is a JSON object with "meta" and "colors".'] }
  for (const key of Object.keys(input)) {
    if (!['meta', 'colors', 'radius', 'avatarShape', 'fonts'].includes(key)) errors.push(`Unknown key "${key}".`)
  }

  const meta: ThemeFile['meta'] = { name: '' }
  if (!isPlainObject(input.meta)) errors.push('"meta" must be an object with a "name".')
  else {
    for (const key of Object.keys(input.meta)) if (!['name', 'desc', 'scheme'].includes(key)) errors.push(`Unknown key "meta.${key}".`)
    const name = cleanText(input.meta.name, 40)
    if (name) meta.name = name
    else errors.push('"meta.name" must be 1–40 characters.')
    if (input.meta.desc !== undefined) {
      const desc = cleanText(input.meta.desc, 120)
      if (desc) meta.desc = desc
      else errors.push('"meta.desc" must be 1–120 characters.')
    }
    if (input.meta.scheme !== undefined) {
      if (input.meta.scheme === 'dark' || input.meta.scheme === 'light') meta.scheme = input.meta.scheme
      else errors.push('"meta.scheme" must be "dark" or "light".')
    }
  }

  const colors: ThemeFile['colors'] = {}
  if (input.colors !== undefined && !isPlainObject(input.colors)) errors.push('"colors" must be an object.')
  else if (isPlainObject(input.colors)) {
    for (const [key, value] of Object.entries(input.colors)) {
      if (!(COLOR_KEYS as readonly string[]).includes(key)) {
        errors.push(`Unknown colour "${key}".`)
        continue
      }
      const color = safeColor(value)
      if (color) colors[key as ColorKey] = color
      else errors.push(`"colors.${key}" must be a colour like #7c6fff or rgba(124, 111, 255, 0.5).`)
    }
  }

  const theme: ThemeFile = { meta, colors }
  if (input.radius !== undefined) {
    if (typeof input.radius === 'number' && Number.isInteger(input.radius) && input.radius >= 0 && input.radius <= 24) theme.radius = input.radius
    else errors.push('"radius" must be a whole number from 0 to 24.')
  }
  if (input.avatarShape !== undefined) {
    if (typeof input.avatarShape === 'string' && Object.hasOwn(AVATAR_SHAPES, input.avatarShape)) theme.avatarShape = input.avatarShape as ThemeFile['avatarShape']
    else errors.push(`"avatarShape" must be one of: ${Object.keys(AVATAR_SHAPES).join(', ')}.`)
  }
  if (input.fonts !== undefined) {
    if (!isPlainObject(input.fonts)) errors.push('"fonts" must be an object.')
    else {
      theme.fonts = {}
      for (const [key, value] of Object.entries(input.fonts)) {
        const table = key === 'body' ? BODY_FONTS : key === 'mono' ? MONO_FONTS : null
        if (!table) errors.push(`Unknown key "fonts.${key}".`)
        else if (typeof value === 'string' && Object.hasOwn(table, value)) (theme.fonts as Record<string, string>)[key] = value
        else errors.push(`"fonts.${key}" must be one of: ${Object.keys(table).join(', ')}.`)
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, theme }
}

export function parseTheme(text: string): ThemeResult {
  if (text.length > MAX_THEME_CHARS) return { ok: false, errors: [`Themes can be up to ${MAX_THEME_CHARS} characters.`] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] }
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

/** White or near-black text for the given background colour. */
export function textOn(color: string): string {
  const rgb = rgbOf(color)
  if (!rgb) return '#ffffff'
  const l = luminance(rgb)
  // White unless it drops below 3:1 (fine for button labels), the way most design systems pick.
  return 1.05 / (l + 0.05) >= 3 ? '#ffffff' : '#0b0b14'
}

// ── Applying ────────────────────────────────────────────────────────────────

/** The CSS variables a theme sets (null for the default, which is plain styles.css). */
export function themeVariables(theme: ThemeFile): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const { name, key, fallback } of VARIABLES) vars[name] = theme.colors[key] ?? fallback
  if (!theme.colors.onAccent && theme.colors.accent) vars['--on-accent'] = textOn(theme.colors.accent)
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
