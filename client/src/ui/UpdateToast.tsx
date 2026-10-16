import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { desktop } from '../platform/desktop'
import { parseUpdateStatus, updateNotice, type UpdateStatus } from '../platform/updates'
import { Close } from './icons'
import './update-toast.css'

const DISMISSED = 'iskra.update-dismissed'

/**
 * The app's toast, bottom right over the message box: a mark, a title and a line, maybe a button, and ✕. The update
 * notice below and the desktop shell's own notices (DesktopNotices.tsx) share it, so they look the same.
 */
export function Toast({ mark, title, body, action, onClose, closeLabel, closeTitle, className, testId }: {
  mark?: ReactNode
  title: string
  body: string
  action?: ReactNode
  onClose: () => void
  closeLabel: string
  closeTitle?: string
  className?: string
  testId?: string
}) {
  return (
    <div className={`update-toast ${className ?? ''}`} role="status" aria-live="polite" data-testid={testId}>
      {mark && <div className="update-toast-mark" aria-hidden="true">{mark}</div>}
      <div className="update-toast-text">
        <strong>{title}</strong>
        <span>{body}</span>
      </div>
      {action}
      <button className="icon-button" onClick={onClose} aria-label={closeLabel} title={closeTitle ?? closeLabel}>
        <Close size={16} />
      </button>
    </div>
  )
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

/** The desktop app's update status, live ({ state: 'none' } outside the desktop app). */
function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'none' })
  useEffect(() => {
    if (!desktop?.updates) return
    void desktop.updates.status().then((s) => setStatus(parseUpdateStatus(s)))
    return desktop.updates.onStatus((s) => setStatus(parseUpdateStatus(s)))
  }, [])
  return status
}

/**
 * Desktop only: a green button at the top of the server rail from the moment a new version is found until you're on
 * it. It can't be dismissed: downloading (pulsing), then a click restarts into it, or opens the download page for
 * builds that can't update themselves.
 */
export function UpdateRailButton() {
  const { t } = useTranslation()
  const status = useUpdateStatus()
  const [restarting, setRestarting] = useState(false)
  if (status.state === 'none') return null
  const label = status.state === 'downloading' ? t('app.update.railDownloading', { version: status.version })
    : status.state === 'ready' ? t('app.update.railReady', { version: status.version })
      : t('app.update.railAvailable', { version: status.version })
  const icon = (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  )
  if (status.state === 'available') {
    return <a className={`server-icon update-rail ${status.state}`} href={status.url} target="_blank" rel="noreferrer" title={label} aria-label={label} data-testid="update-rail">{icon}</a>
  }
  async function restart() {
    setRestarting(true)
    if (!(await desktop?.updates.restart())) setRestarting(false)
  }
  return (
    <button className={`server-icon update-rail ${status.state}`} title={label} aria-label={label} data-testid="update-rail"
      aria-disabled={status.state === 'downloading' || restarting} onClick={() => status.state === 'ready' && !restarting && void restart()}>
      {icon}
    </button>
  )
}

/** Desktop only: "Update ready, restart" once an update has downloaded, or a download link for builds that can't update themselves. */
export function UpdateToast() {
  const { t } = useTranslation()
  const status = useUpdateStatus()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [restarting, setRestarting] = useState(false)

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
    <Toast
      mark={<DownloadMark />}
      title={notice.kind === 'ready' ? t('app.update.ready') : t('app.update.available')}
      body={notice.kind === 'ready' ? t('app.update.readyBody', { version: notice.version }) : t('app.update.availableBody', { version: notice.version })}
      action={notice.kind === 'ready' ? (
        <button className="button primary" onClick={() => void restart()} disabled={restarting}>
          {restarting ? t('app.update.restarting') : t('app.update.restart')}
        </button>
      ) : (
        <a className="button primary" href={notice.url} target="_blank" rel="noreferrer">
          {t('common.download')}
        </a>
      )}
      onClose={dismiss}
      closeLabel={notice.kind === 'ready' ? t('app.update.later') : t('app.dismiss')}
      closeTitle={notice.kind === 'ready' ? t('app.update.laterTitle') : t('app.dismiss')}
    />
  )
}

/** The download arrow in a toast's mark. */
export const DownloadMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
)
