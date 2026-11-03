// Fonts are the person's own setting (Settings → Appearance → Font), saved per device in "iskra.font". Built-in
// themes name no font, so switching between them never changes the text. A theme someone imports, writes or has the
// assistant make may name one ("fonts" in the theme file): it applies while "Use the theme's font when it names one"
// is on (the default), and the person's choice applies otherwise.
//
// Inter, Nunito (Rounded) and JetBrains Mono ship with the app (fonts.css, SIL Open Font License); System and Serif
// are the device's own fonts. Every stack is a fixed string from the tables below, never text from a theme file.

export const BODY_FONTS = {
  inter: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  rounded: "Nunito, ui-rounded, 'SF Pro Rounded', 'Segoe UI', system-ui, sans-serif",
  serif: "'Iowan Old Style', Charter, Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
} as const
export const MONO_FONTS = {
  jetbrains: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
  system: "ui-monospace, Menlo, Consolas, 'Courier New', monospace",
} as const

export type BodyFont = keyof typeof BODY_FONTS
export type MonoFont = keyof typeof MONO_FONTS
export const BODY_FONT_IDS = Object.keys(BODY_FONTS) as BodyFont[]
export const MONO_FONT_IDS = Object.keys(MONO_FONTS) as MonoFont[]

export interface FontPrefs {
  body: BodyFont
  mono: MonoFont
  /** Use the font a theme names (custom themes only: built-ins name none). */
  useThemeFont: boolean
}

export const DEFAULT_FONT_PREFS: FontPrefs = { body: 'inter', mono: 'jetbrains', useThemeFont: true }

export const FONT_STORAGE_KEY = 'iskra.font'

/** What a theme file says about fonts; only the shape fonts need (theme.ts ThemeFile). */
interface FontsOf { fonts?: { body?: BodyFont; mono?: MonoFont } }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype

/**
 * What's saved, re-checked (storage is never trusted): unknown or broken values fall back to the defaults, one by
 * one. Nothing saved yet (everyone before fonts were their own setting) is the defaults too: Inter, JetBrains Mono,
 * theme fonts on.
 */
export function loadFontPrefs(storage: Pick<Storage, 'getItem'> = localStorage): FontPrefs {
  const prefs = { ...DEFAULT_FONT_PREFS }
  try {
    const saved = JSON.parse(storage.getItem(FONT_STORAGE_KEY) ?? 'null') as unknown
    if (!isPlainObject(saved)) return prefs
    if (typeof saved.body === 'string' && Object.hasOwn(BODY_FONTS, saved.body)) prefs.body = saved.body as BodyFont
    if (typeof saved.mono === 'string' && Object.hasOwn(MONO_FONTS, saved.mono)) prefs.mono = saved.mono as MonoFont
    if (typeof saved.useThemeFont === 'boolean') prefs.useThemeFont = saved.useThemeFont
  } catch {
    /* corrupt or blocked storage: the defaults */
  }
  return prefs
}

export function saveFontPrefs(prefs: FontPrefs, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(FONT_STORAGE_KEY, JSON.stringify({ body: prefs.body, mono: prefs.mono, useThemeFont: prefs.useThemeFont }))
  } catch {
    /* private mode: the choice just won't stick */
  }
}

export interface EffectiveFonts {
  body: BodyFont
  mono: MonoFont
  /** Which of the two come from the theme rather than the person's choice. */
  fromTheme: { body: boolean; mono: boolean }
}

/** The fonts in use: the theme's when it names one and the person allows it, otherwise the person's own. */
export function effectiveFonts(theme: FontsOf | null, prefs: FontPrefs): EffectiveFonts {
  const named = prefs.useThemeFont ? theme?.fonts : undefined
  const body = named?.body && Object.hasOwn(BODY_FONTS, named.body) ? named.body : null
  const mono = named?.mono && Object.hasOwn(MONO_FONTS, named.mono) ? named.mono : null
  return { body: body ?? prefs.body, mono: mono ?? prefs.mono, fromTheme: { body: !!body, mono: !!mono } }
}

/** The two CSS variables the fonts drive. */
export function fontVariables(fonts: Pick<EffectiveFonts, 'body' | 'mono'>): Record<'--font' | '--mono', string> {
  return { '--font': BODY_FONTS[fonts.body], '--mono': MONO_FONTS[fonts.mono] }
}

export function applyFonts(theme: FontsOf | null, prefs: FontPrefs, root: HTMLElement = document.documentElement): EffectiveFonts {
  const fonts = effectiveFonts(theme, prefs)
  for (const [name, value] of Object.entries(fontVariables(fonts))) root.style.setProperty(name, value)
  root.dataset.font = fonts.body
  return fonts
}

/** Saves the person's font choice and applies it under the current theme. */
export function chooseFonts(prefs: FontPrefs, theme: FontsOf | null): EffectiveFonts {
  saveFontPrefs(prefs)
  return applyFonts(theme, prefs)
}
