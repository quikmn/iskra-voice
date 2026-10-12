// Settings → Voice & audio → Captions: opt in, the language, your own voice, and what turning it on downloads.
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { formatBytes } from '../../i18n/format'
import {
  approveCaptionDownload, cancelCaptionDownload, captionsSupported, refreshCaptionCache, updateCaptions, useCaptions,
  type CaptionChoice,
} from '../../state/captions'
import { captionDownloadBytes } from '../../state/models'
import './media.css'

/** How captions are doing, with the download's yes/cancel/retry buttons (shared with the call screen). */
export function CaptionStatusText() {
  const { t } = useTranslation()
  const status = useCaptions((s) => s.status)
  const progress = useCaptions((s) => s.progress)
  const cached = useCaptions((s) => s.cached)
  const size = formatBytes(captionDownloadBytes())
  if (status === 'needsDownload') {
    return (
      <>
        {t('media.captions.needsDownload', { size })}{' '}
        <span className="caption-actions">
          <button className="button small primary" onClick={approveCaptionDownload}>{t('media.captions.downloadNow')}</button>
          <button className="button small" onClick={cancelCaptionDownload}>{t('media.captions.notNow')}</button>
        </span>
      </>
    )
  }
  if (status === 'loading') {
    return (
      <>
        {cached ? t('media.captions.loading', { percent: Math.round(progress * 100) }) : t('media.captions.downloading', { size, percent: Math.round(progress * 100) })}{' '}
        {!cached && <progress className="caption-progress" max={1} value={progress} aria-hidden="true" />}
        {!cached && <span className="caption-actions"><button className="button small" onClick={cancelCaptionDownload}>{t('common.cancel')}</button></span>}
      </>
    )
  }
  if (status === 'downloadFailed' || status === 'corrupt') {
    return (
      <>
        {t(status === 'corrupt' ? 'media.captions.corrupt' : 'media.captions.downloadFailed')}{' '}
        <span className="caption-actions"><button className="button small" onClick={approveCaptionDownload}>{t('media.captions.retry')}</button></span>
      </>
    )
  }
  if (status === 'notOffered') return <>{t('media.captions.notOffered')}</>
  if (status === 'slow') return <>{t('media.captions.slow')}</>
  if (status === 'error') return <>{t('media.captions.error')}</>
  if (status === 'unsupported') return <>{t('media.captions.unsupported')}</>
  if (status === 'ready') return <>{t('media.captions.ready')}</>
  return null
}

export function CaptionSettingsSection() {
  const { t } = useTranslation()
  const settings = useCaptions((s) => s.settings)
  const status = useCaptions((s) => s.status)
  const cached = useCaptions((s) => s.cached)
  const supported = captionsSupported()
  useEffect(refreshCaptionCache, [status])

  return (
    <section className="settings-section media-settings">
      <h3>{t('media.captions.title')}</h3>
      <label className="checkbox">
        <input type="checkbox" checked={settings.enabled} disabled={!supported} onChange={(e) => updateCaptions({ enabled: e.target.checked })} />
        {t('media.captions.show')}
      </label>
      <p className="muted">{t('media.captions.hint')}</p>
      {supported ? (
        <p className="muted">{cached ? t('media.captions.downloaded') : t('media.captions.download', { size: formatBytes(captionDownloadBytes()) })}</p>
      ) : (
        <p className="muted">{t('media.captions.unsupported')}</p>
      )}
      <label className="field">
        <span>{t('media.captions.language')}</span>
        <select value={settings.language} disabled={!supported} onChange={(e) => updateCaptions({ language: e.target.value as CaptionChoice })}>
          <option value="auto">{t('media.captions.auto')}</option>
          <option value="en">{t('media.captions.en')}</option>
          <option value="sv">{t('media.captions.sv')}</option>
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.includeSelf} disabled={!supported} onChange={(e) => updateCaptions({ includeSelf: e.target.checked })} />
        {t('media.captions.includeSelf')}
      </label>
      {settings.enabled && status !== 'off' && <p className="muted" role="status"><CaptionStatusText /></p>}
    </section>
  )
}
