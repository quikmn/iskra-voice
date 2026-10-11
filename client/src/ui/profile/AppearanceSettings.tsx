// Settings → Appearance: pick a look (it applies right away), or import, edit and export theme JSON.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chooseTheme, loadThemeChoice, parseTheme, themeFor, type ThemeChoice, type ThemeFile } from '../../theme/theme'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID } from '../../theme/themes'
import './profile.css'

const swatches = (theme: ThemeFile) => [theme.colors.bgDeep ?? '#0b0b14', theme.colors.accent ?? '#7c6fff', theme.colors.link ?? '#00cfff']

export function AppearanceSection() {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<ThemeChoice>(loadThemeChoice)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const current = themeFor(choice) ?? BUILT_IN_THEMES[0].theme
  const custom = 'custom' in choice ? choice.custom : null

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
    const blob = new Blob([JSON.stringify(current, null, 2) + '\n'], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${current.meta.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'theme'}.iskra-theme.json`
    document.body.appendChild(link) // in the document, so the phone app can route it to the share sheet
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  return (
    <section className="settings-section">
      <h3>{t('settings.sections.appearance')}</h3>
      <div className="theme-grid" role="radiogroup" aria-label={t('profile.theme.label')}>
        {BUILT_IN_THEMES.map(({ id, theme }) => {
          const active = 'id' in choice && choice.id === id
          return (
            <button key={id} role="radio" aria-checked={active} className={`theme-option ${active ? 'active' : ''}`} onClick={() => pick({ id })}>
              <span className="theme-dots" style={{ background: theme.colors.bgChat }}>
                {swatches(theme).map((c, i) => <span key={i} style={{ background: c }} />)}
              </span>
              <span className="theme-name">{id === DEFAULT_THEME_ID ? t('profile.theme.defaultName', { name: theme.meta.name }) : theme.meta.name}</span>
            </button>
          )
        })}
        {custom && (
          <button role="radio" aria-checked className="theme-option active" onClick={() => setEditing(true)}>
            <span className="theme-dots" style={{ background: custom.colors.bgChat ?? 'var(--surface)' }}>
              {swatches(custom).map((c, i) => <span key={i} style={{ background: c }} />)}
            </span>
            <span className="theme-name">{custom.meta.name}</span>
          </button>
        )}
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
      {errors.length > 0 && (
        <ul className="error-text theme-errors">
          {errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
    </section>
  )
}
