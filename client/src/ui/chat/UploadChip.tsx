// A file waiting in the composer (channels, threads and DMs): one row of thumbnail, name over size (or progress, or
// why it failed), a spoiler eye and a remove ✕.
import { useTranslation } from 'react-i18next'
import { formatNumber } from '../../i18n/format'
import { Close, EyeOff, FileIcon } from '../icons'
import { formatSize } from './helpers'

export function UploadChip({ name, size, preview, progress, done, error, spoiler, onSpoiler, onRemove }: {
  name: string
  size: number
  preview: string | null
  progress: number
  done: boolean
  error: string | null
  spoiler: boolean
  onSpoiler: () => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className={`pending-upload ${error ? 'failed' : ''} ${spoiler ? 'spoiler' : ''}`} title={error ?? name}>
      <span className="upload-thumb" aria-hidden>
        {preview ? <img src={preview} alt="" className={spoiler ? 'spoiler-preview' : undefined} /> : <FileIcon size={20} />}
      </span>
      <span className="upload-text">
        <span className="file-name">{name}</span>
        {error
          ? <span className="upload-error" role="alert">{error}</span>
          : <span className="upload-meta">{done ? formatSize(size) : formatNumber(progress, { style: 'percent', maximumFractionDigits: 0 })}</span>}
        {!done && !error && <span className="upload-bar" aria-hidden><span style={{ width: `${progress * 100}%` }} /></span>}
      </span>
      {!error && (
        <button className={`icon-button small upload-spoiler ${spoiler ? 'on' : ''}`} onClick={onSpoiler} aria-pressed={spoiler}
          aria-label={spoiler ? t('chat.media.spoiler') : t('chat.media.markSpoiler')} title={spoiler ? t('chat.media.spoilerOnTitle') : t('chat.media.spoilerOffTitle')}>
          <EyeOff size={16} />
        </button>
      )}
      <button className="icon-button small upload-remove" onClick={onRemove} aria-label={t('chat.composer.removeFile', { name })}>
        <Close size={14} />
      </button>
    </div>
  )
}
