import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop } from '../platform/desktop'
import { parseUpdateStatus, updateNotice, type UpdateStatus } from '../platform/updates'
import { Close } from './icons'
import './update-toast.css'

const DISMISSED = 'iskra.update-dismissed'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

/** Desktop only: "Update ready, restart" once an update has downloaded, or a download link for builds that can't update themselves. */
export function UpdateToast() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<UpdateStatus>({ state: 'none' })
  const [dismissed, setDismissed] = useState(readDismissed)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    if (!desktop?.updates) return
    void desktop.updates.status().then((s) => setStatus(parseUpdateStatus(s)))
    return desktop.updates.onStatus((s) => setStatus(parseUpdateStatus(s)))
  }, [])

  const notice = updateNotice(status, dismissed)
  if (!notice) return null

  function dismiss() {
    if (!notice) return
    setDismissed(notice.version)
    try {
      localStorage.setItem(DISMISSED, notice.version)
    } catch {
      /* private mode */
    }
  }

  async function restart() {
    setRestarting(true)
    if (!(await desktop?.updates.restart())) setRestarting(false)
  }

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <div className="update-toast-mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </div>
      <div className="update-toast-text">
        <strong>{notice.kind === 'ready' ? t('app.update.ready') : t('app.update.available')}</strong>
        <span>
          {notice.kind === 'ready' ? t('app.update.readyBody', { version: notice.version }) : t('app.update.availableBody', { version: notice.version })}
        </span>
      </div>
      {notice.kind === 'ready' ? (
        <button className="button primary" onClick={() => void restart()} disabled={restarting}>
          {restarting ? t('app.update.restarting') : t('app.update.restart')}
        </button>
      ) : (
        <a className="button primary" href={notice.url} target="_blank" rel="noreferrer">
          {t('common.download')}
        </a>
      )}
      <button className="icon-button" onClick={dismiss} aria-label={notice.kind === 'ready' ? t('app.update.later') : t('app.dismiss')} title={notice.kind === 'ready' ? t('app.update.laterTitle') : t('app.dismiss')}>
        <Close size={16} />
      </button>
    </div>
  )
}
