// "Show transcript" on a voice message, and the text (or what's happening with it) under the player. Made on this
// device by state/transcripts.ts; nothing is uploaded.
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../../../i18n/format'
import { captionDownloadBytes } from '../../../state/models'
import {
  approveTranscriptDownload, cancelTranscriptDownload, hideTranscript, showTranscript, useTranscripts, useVoiceTranscript, type TranscriptItem,
} from '../../../state/transcripts'
import { onPhone } from '../../../state/translate'

const TranscriptIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M4 6h16M4 11h16M4 16h10M4 21h7" />
  </svg>
)

/** The transcript toggle in the player's row, and the block under it. */
export function useTranscriptParts(item: TranscriptItem | null) {
  const { t } = useTranslation()
  const id = useId()
  const entry = useVoiceTranscript(item)
  if (!item) return { button: null, block: null }
  const shown = !!entry?.shown
  const label = shown ? t('speech.transcript.hide') : t('speech.transcript.show')
  const button = (
    <button className={`voice-transcript-toggle ${shown ? 'on' : ''}`} onClick={() => (shown ? hideTranscript(item.key) : showTranscript(item))}
      aria-label={label} title={label} aria-expanded={shown} aria-controls={shown ? id : undefined}>
      <TranscriptIcon />
    </button>
  )
  return { button, block: shown && entry ? <TranscriptBlock id={id} item={item} /> : null }
}

function TranscriptBlock({ id, item }: { id: string; item: TranscriptItem }) {
  const { t } = useTranslation()
  const entry = useTranscripts((s) => s.entries[item.key])
  const progress = useTranscripts((s) => s.progress)
  if (!entry) return null
  const retry = <button className="link" onClick={() => showTranscript(item)}>{t('common.retry')}</button>
  switch (entry.status) {
    case 'done':
      return <p id={id} className="voice-transcript" data-testid="voice-transcript">{entry.text}</p>
    case 'empty':
      return <p id={id} className="voice-transcript muted">{t('speech.transcript.empty')}</p>
    case 'working':
      return <p id={id} className="voice-transcript muted" role="status">{t('speech.transcript.working')}</p>
    case 'loading':
      return (
        <p id={id} className="voice-transcript muted" role="status">
          {t('speech.transcript.loading', { percent: Math.round(progress * 100) })}{' '}
          <progress max={1} value={progress} aria-hidden="true" />{' '}
          <button className="link" onClick={cancelTranscriptDownload}>{t('common.cancel')}</button>
        </p>
      )
    case 'needsDownload':
      return (
        <div id={id} className="voice-transcript notice" data-testid="transcript-download">
          <p>{t('speech.transcript.needsDownload', { size: formatBytes(captionDownloadBytes()) })}{onPhone() && <> {t('translate.phoneWarning')}</>}</p>
          <div className="voice-transcript-actions">
            <button className="button small primary" onClick={approveTranscriptDownload}>{t('speech.transcript.download')}</button>
            <button className="button small" onClick={() => hideTranscript(item.key)}>{t('speech.transcript.notNow')}</button>
          </div>
        </div>
      )
    case 'tooSlow':
      return <p id={id} className="voice-transcript notice" role="alert">{t('speech.transcript.tooSlow')} {retry}</p>
    case 'notOffered':
      return <p id={id} className="voice-transcript notice">{t('speech.transcript.notOffered')}</p>
    case 'unsupported':
      return <p id={id} className="voice-transcript notice">{t('speech.transcript.unsupported')}</p>
    case 'downloadFailed':
      return <p id={id} className="voice-transcript notice" role="alert">{t('speech.transcript.downloadFailed')} {retry}</p>
    case 'corrupt':
      return <p id={id} className="voice-transcript notice" role="alert">{t('speech.transcript.corrupt')} {retry}</p>
    default:
      return <p id={id} className="voice-transcript notice" role="alert">{t('speech.transcript.failed')} {retry}</p>
  }
}
