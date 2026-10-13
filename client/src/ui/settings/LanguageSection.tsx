// My settings → Language: follow the system, or pick one. It applies right away.
import { useTranslation } from 'react-i18next'
import { LANGUAGE_NAMES, LANGUAGES, setLanguageChoice, useLanguageChoice, type LanguageChoice } from '../../i18n'

export function LanguageSection() {
  const { t } = useTranslation()
  const choice = useLanguageChoice((s) => s.choice)
  return (
    <section className="settings-section">
      <h2>{t('common.language.title')}</h2>
      <label className="field">
        <select value={choice} aria-label={t('common.language.title')} onChange={(e) => setLanguageChoice(e.target.value as LanguageChoice)}>
          <option value="auto">{t('common.language.auto')}</option>
          {LANGUAGES.map((language) => <option key={language} value={language} lang={language}>{LANGUAGE_NAMES[language]}</option>)}
        </select>
        {choice === 'auto' && <small className="muted">{t('common.language.autoHint')}</small>}
      </label>
    </section>
  )
}
