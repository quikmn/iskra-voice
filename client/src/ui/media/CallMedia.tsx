// In the call screen: the captions button and overlay (each speaker's name and their last words, read out politely
// by screen readers), and the notice when your background effect had to turn itself off.
import { useTranslation } from 'react-i18next'
import { captionsSupported, updateCaptions, useCaptions } from '../../state/captions'
import { dismissBackgroundNotice, useBackground } from '../../state/background'
import { activeRoom } from '../../state/voice'
import { Captions, Close } from '../icons'
import { CaptionStatusText } from './CaptionSettings'
import './media.css'

/** At most this many speakers' captions at once (the newest). */
const MAX_SHOWN = 3

export function CaptionsButton() {
  const { t } = useTranslation()
  const enabled = useCaptions((s) => s.settings.enabled)
  if (!captionsSupported()) return null
  const label = enabled ? t('media.captions.turnOff') : t('media.captions.turnOn')
  return (
    <button className={`call-button ${enabled ? 'on' : ''}`} onClick={() => updateCaptions({ enabled: !enabled })} aria-pressed={enabled} aria-label={label} title={label}>
      <Captions />
    </button>
  )
}

export function CaptionsOverlay({ nameOf }: { nameOf: (accountKey: string) => string }) {
  const { t } = useTranslation()
  const enabled = useCaptions((s) => s.settings.enabled)
  const status = useCaptions((s) => s.status)
  const lines = useCaptions((s) => s.lines)
  if (!enabled) return null
  const me = activeRoom()?.localParticipant.identity
  const shown = Object.entries(lines)
    .filter(([, l]) => l.text || l.speaking)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(-MAX_SHOWN)
  const note = status !== 'ready' && status !== 'off'
  return (
    <section className="captions-overlay" aria-label={t('media.captions.overlay')}>
      <div className="captions-lines" aria-live="polite" aria-relevant="additions text">
        {shown.map(([key, line]) => (
          <p key={key} className="caption-line" data-speaker={key}>
            <strong>{key === me ? t('media.captions.you') : nameOf(key)}</strong>{' '}
            <span className={line.text ? '' : 'muted'}>{line.text || t('media.captions.talking')}</span>
          </p>
        ))}
        {!shown.length && !note && <p className="caption-line muted">{t('media.captions.waiting')}</p>}
      </div>
      {note && <p className="caption-status" role="status"><CaptionStatusText /></p>}
      <button className="icon-button captions-close" onClick={() => updateCaptions({ enabled: false })} aria-label={t('media.captions.turnOff')} title={t('media.captions.turnOff')}>
        <Close size={14} />
      </button>
    </section>
  )
}

export function BackgroundNotice() {
  const { t } = useTranslation()
  const notice = useBackground((s) => s.notice)
  if (!notice) return null
  return (
    <p className="call-error background-notice" role="alert">
      {notice === 'slow' ? t('media.background.slowNotice') : t('media.background.failedNotice')}
      <button className="button small" onClick={dismissBackgroundNotice}>{t('media.background.dismiss')}</button>
    </p>
  )
}
