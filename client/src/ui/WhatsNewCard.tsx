// "What's new in Iskra X": the new version's highlights, once after an update (state/whatsNew.ts).
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { releaseNotesUrl } from '../releaseNotes'
import { dismissWhatsNew, linesFor, useWhatsNew } from '../state/whatsNew'
import { Close } from './icons'
import './whats-new.css'

export function WhatsNewCard() {
  const { t, i18n } = useTranslation()
  const notes = useWhatsNew((s) => s.notes)
  const titleId = useId()
  if (!notes) return null
  const lines = linesFor(notes, i18n.language)
  return (
    <section className="whats-new" aria-labelledby={titleId} data-testid="whats-new">
      <div className="whats-new-head">
        <div className="whats-new-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
            <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
          </svg>
        </div>
        <h2 id={titleId}>{t('whatsNew.title', { version: notes.version })}</h2>
        <button className="icon-button" onClick={dismissWhatsNew} aria-label={t('whatsNew.dismiss')} title={t('whatsNew.dismiss')}>
          <Close size={16} />
        </button>
      </div>
      <ul className="whats-new-lines">
        {lines.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
      <div className="whats-new-actions">
        <a className="whats-new-link" href={releaseNotesUrl(notes.version)} target="_blank" rel="noreferrer">{t('whatsNew.fullNotes')}</a>
        <button className="button primary" onClick={dismissWhatsNew}>{t('whatsNew.gotIt')}</button>
      </div>
    </section>
  )
}
