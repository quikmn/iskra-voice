// Settings → Appearance: pick a look (it applies right away), or import, edit and export theme JSON; and the font,
// which is the person's own setting (a theme only changes it when it names one and they allow it).
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chooseTheme, contrastIssues, effectiveColor, loadThemeChoice, parseTheme, themeFor, type ColorKey, type ContrastIssue, type ThemeChoice, type ThemeFile } from '../../theme/theme'
import { BODY_FONT_IDS, BODY_FONTS, chooseFonts, effectiveFonts, loadFontPrefs, MONO_FONT_IDS, type BodyFont, type FontPrefs, type MonoFont } from '../../theme/fonts'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, type ThemeGroup } from '../../theme/themes'
import './profile.css'

const GROUPS: ThemeGroup[] = ['house', 'classic', 'loud']
/** The i18n name of a code font (profile.font.names). */
const monoName = (id: MonoFont) => (id === 'system' ? 'systemMono' : id)

/**
 * A small picture of the app in the theme's colours: the rail, the sidebar with a selected row, the chat with two
 * lines of text and an accent button. Every colour has passed validateTheme (or is a built-in), so it's safe in style.
 */
function ThemePreview({ theme }: { theme: ThemeFile }) {
  const c = (key: ColorKey) => effectiveColor(theme, key)
  return (
    <span className="theme-preview" style={{ background: c('bgSurface') }} aria-hidden>
      <span className="theme-preview-side" style={{ background: c('bgSidebar') }}>
        <span className="theme-preview-row" style={{ background: c('bgActive') }}><span style={{ background: c('textNormal') }} /></span>
        <span className="theme-preview-row"><span style={{ background: c('textSubtle') }} /></span>
        <span className="theme-preview-row"><span style={{ background: c('textSubtle') }} /></span>
      </span>
      <span className="theme-preview-chat" style={{ background: c('bgChat') }}>
        <span className="theme-preview-line" style={{ background: c('textNormal') }} />
        <span className="theme-preview-line short" style={{ background: c('textSubtle') }} />
        <span className="theme-preview-line link" style={{ background: c('link') }} />
        <span className="theme-preview-pill" style={{ background: c('accent') }} />
      </span>
    </span>
  )
}

export function AppearanceSection() {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<ThemeChoice>(loadThemeChoice)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const current = themeFor(choice)
  const custom = 'custom' in choice ? choice.custom : null
  // Contrast of what's being written (once it's valid), or of the custom theme in use.
  const draft = editing ? parseTheme(text) : null
  const checked = draft ? (draft.ok ? draft.theme : null) : custom
  const issues = checked ? contrastIssues(checked) : []

  /** Puts a suggested colour into the editor, or straight into the custom theme in use. */
  function fix(key: ColorKey, color: string) {
    if (!checked) return
    const next: ThemeFile = { ...checked, colors: { ...checked.colors, [key]: color } }
    if (editing) setText(JSON.stringify(next, null, 2))
    else pick({ custom: next })
  }

  function pick(next: ThemeChoice) {
    chooseTheme(next)
    setChoice(next)
    setErrors([])
  }

  function applyText(source: string) {
    const result = parseTheme(source)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    pick({ custom: result.theme })
    setEditing(false)
  }

  function exportTheme() {
    // The theme file as it is: the person's own font choice never goes into it.
    const blob = new Blob([JSON.stringify(current, null, 2) + '\n'], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${current.meta.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'theme'}.iskra-theme.json`
    document.body.appendChild(link) // in the document, so the phone app can route it to the share sheet
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  const fontChip = (theme: ThemeFile) => {
    const body = theme.fonts?.body
    if (!body) return null
    const font = t(`profile.font.names.${body}`)
    return (
      <span className="theme-font-chip" style={{ fontFamily: BODY_FONTS[body] }} aria-label={t('profile.theme.fontChipLabel', { font })}>
        {t('profile.theme.fontChip', { font })}
      </span>
    )
  }

  return (
    <>
      <section className="settings-section">
        <h2>{t('settings.sections.appearance')}</h2>
        <div className="theme-groups" role="radiogroup" aria-label={t('profile.theme.label')}>
          {GROUPS.map((group) => (
            <div key={group} className="theme-group">
              <p className="theme-group-label" aria-hidden>{t(`profile.theme.groups.${group}`)}</p>
              <div className="theme-grid">
                {BUILT_IN_THEMES.filter((b) => b.group === group).map(({ id, theme }) => {
                  const active = 'id' in choice && choice.id === id
                  return (
                    <button key={id} role="radio" aria-checked={active} title={theme.meta.desc} className={`theme-option ${active ? 'active' : ''}`} onClick={() => pick({ id })}>
                      <ThemePreview theme={theme} />
                      <span className="theme-name">{id === DEFAULT_THEME_ID ? t('profile.theme.defaultName', { name: theme.meta.name }) : theme.meta.name}</span>
                      {fontChip(theme)}
                    </button>
                  )
                })}
                {group === 'house' && custom && (
                  <button role="radio" aria-checked className="theme-option active" title={custom.meta.desc} onClick={() => setEditing(true)}>
                    <ThemePreview theme={custom} />
                    <span className="theme-name">{custom.meta.name}</span>
                    {fontChip(custom)}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="copy-row theme-actions">
          <button className="button small" onClick={() => { setText(JSON.stringify(current, null, 2)); setErrors([]); setEditing(!editing) }}>
            {editing ? t('profile.theme.closeEditor') : t('profile.theme.writeOwn')}
          </button>
          <button className="button small" onClick={() => fileInput.current?.click()}>{t('profile.theme.import')}</button>
          <button className="button small" onClick={exportTheme}>{t('profile.theme.export')}</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label={t('profile.theme.file')}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              if (file.size > 64 * 1024) setErrors([t('profile.theme.tooBig')])
              else applyText(await file.text())
            }}
          />
        </div>

        {editing && (
          <div className="theme-editor">
            <textarea value={text} rows={12} spellCheck={false} aria-label={t('profile.theme.json')} onChange={(e) => { setText(e.target.value); setErrors([]) }} />
            <p className="muted">{t('profile.theme.help')}</p>
            <button className="button primary small" onClick={() => applyText(text)}>{t('common.apply')}</button>
          </div>
        )}
        {issues.length > 0 && <ContrastWarnings issues={issues} onFix={fix} />}
        {errors.length > 0 && (
          <ul className="error-text theme-errors">
            {errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
      </section>
      <FontSection theme={current} />
    </>
  )
}

/** The person's font (radio cards, each "Aa" drawn in its font), the code font, and "Use the theme's font". */
function FontSection({ theme }: { theme: ThemeFile }) {
  const { t } = useTranslation()
  const [prefs, setPrefs] = useState<FontPrefs>(loadFontPrefs)
  const fonts = effectiveFonts(theme, prefs)
  const themeBody = fonts.fromTheme.body
  const themeMono = fonts.fromTheme.mono

  function change(next: FontPrefs) {
    chooseFonts(next, theme)
    setPrefs(next)
  }

  /** Picking a font while the theme's is in effect means "this one, please": the theme's font stops applying. */
  const pickBody = (body: BodyFont) => change({ ...prefs, body, useThemeFont: themeBody ? false : prefs.useThemeFont })
  const pickMono = (mono: MonoFont) => change({ ...prefs, mono, useThemeFont: themeMono ? false : prefs.useThemeFont })

  const names = { font: t(`profile.font.names.${fonts.body}`), mono: t(`profile.font.names.${monoName(fonts.mono)}`), theme: theme.meta.name }
  const helper = !prefs.useThemeFont
    ? null
    : themeBody && themeMono
      ? t('profile.font.themeUsesBoth', names)
      : themeBody
        ? t('profile.font.themeUses', names)
        : themeMono
          ? t('profile.font.themeUsesMono', names)
          : t('profile.font.themeNone')

  return (
    <section className="settings-section font-settings" aria-labelledby="font-settings-title">
      <h2 id="font-settings-title">{t('profile.font.label')}</h2>
      <div className="font-grid" role="radiogroup" aria-label={t('profile.font.label')}>
        {BODY_FONT_IDS.map((id) => {
          const mine = prefs.body === id
          const inUse = fonts.body === id
          return (
            <button
              key={id}
              role="radio"
              aria-checked={mine}
              className={`font-option ${mine ? 'active' : ''} ${inUse ? 'in-use' : ''}`}
              title={mine && themeBody ? t('profile.font.yourChoice') : undefined}
              onClick={() => pickBody(id)}
            >
              <span className="font-sample" style={{ fontFamily: BODY_FONTS[id] }} aria-hidden>{t('profile.font.sample')}</span>
              <span className="font-name">{t(`profile.font.names.${id}`)}</span>
              {themeBody && inUse && <span className="font-tag">{t('profile.font.themeTag')}</span>}
              {themeBody && mine && <span className="font-note">{t('profile.font.yourChoice')}</span>}
            </button>
          )
        })}
      </div>
      <label className="field font-code">
        <span>{t('profile.font.code')}</span>
        <select value={prefs.mono} onChange={(e) => pickMono(e.target.value as MonoFont)}>
          {MONO_FONT_IDS.map((id) => <option key={id} value={id}>{t(`profile.font.names.${monoName(id)}`)}</option>)}
        </select>
      </label>
      <label className="checkbox font-use-theme">
        <input type="checkbox" checked={prefs.useThemeFont} onChange={(e) => change({ ...prefs, useThemeFont: e.target.checked })} />
        <span>
          {t('profile.font.useTheme')}
          {helper && <span className="muted font-helper" data-testid="font-helper">{helper}</span>}
        </span>
      </label>
    </section>
  )
}

function ContrastWarnings({ issues, onFix }: { issues: ContrastIssue[]; onFix: (key: ColorKey, color: string) => void }) {
  const { t } = useTranslation()
  // One fix per text colour (it reads on all of that colour's backgrounds).
  const fixes = new Map(issues.map((i) => [i.text, i.fix]))
  return (
    <div className="theme-contrast" role="status" data-testid="theme-contrast">
      <p className="theme-contrast-title">{t('profile.theme.contrast.title')}</p>
      <ul>
        {issues.map((i) => (
          <li key={`${i.text}-${i.background}`}>
            {t('profile.theme.contrast.pair', { text: i.text, background: i.background, ratio: i.ratio.toFixed(2) })}
          </li>
        ))}
      </ul>
      <div className="theme-contrast-fixes">
        {[...fixes].map(([key, color]) => (
          <button key={key} className="button small" onClick={() => onFix(key, color)}>
            <span className="theme-contrast-swatch" style={{ background: color }} aria-hidden />
            {t('profile.theme.contrast.fix', { key, color })}
          </button>
        ))}
      </div>
    </div>
  )
}
