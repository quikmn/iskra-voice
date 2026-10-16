// Desktop only: the shell's own notices (state/desktopNotices.ts) as the app's toast (an update check's result, About
// on the first run) and dialog (the macOS screen-recording permission), worded here in the app's language.
import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { buildLabel } from '../buildInfo'
import { desktop, osName } from '../platform/desktop'
import { answerNoticeDialog, closeNoticeDialog, dismissNoticeToast, startDesktopNotices, useDesktopNotices, type ToastNotice } from '../state/desktopNotices'
import { Modal } from './bits'
import { DownloadMark, Toast } from './UpdateToast'

/** The toast's title and line for a notice. */
export function noticeText(notice: ToastNotice, t: TFunction): { title: string; body: string } {
  if (notice.kind === 'about') {
    const v = desktop?.versions
    return {
      title: t('safety.about.version', { version: buildLabel() }),
      body: desktop && v ? t('safety.about.desktopBuild', { electron: v.electron, chrome: v.chrome, node: v.node, os: osName(desktop.platform), arch: v.arch }) : t('safety.about.tagline'),
    }
  }
  const { version } = notice
  switch (notice.result) {
    case 'found': return { title: t('updates.desktopCheck.downloading', { version }), body: t('updates.desktopCheck.downloadingDetail') }
    case 'up-to-date': return { title: t('updates.desktopCheck.upToDate'), body: t('updates.desktopCheck.upToDateDetail', { version }) }
    case 'off': return { title: t('updates.desktopCheck.off'), body: t('updates.desktopCheck.offDetail') }
    case 'failed': return { title: t('updates.desktopCheck.failed'), body: t('updates.desktopCheck.failedDetail') }
  }
}

const Stroke = ({ children }: { children: ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)
const CheckMark = () => <Stroke><path d="m5 12.5 4.5 4.5L19 7.5" /></Stroke>
const InfoMark = () => <Stroke><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></Stroke>

function mark(notice: ToastNotice) {
  if (notice.kind === 'update-check' && notice.result === 'found') return <DownloadMark />
  if (notice.kind === 'update-check' && notice.result === 'up-to-date') return <CheckMark />
  return <InfoMark />
}

export function DesktopNoticeToast({ notice }: { notice: ToastNotice }) {
  const { t } = useTranslation()
  const { title, body } = noticeText(notice, t)
  return <Toast mark={mark(notice)} title={title} body={body} onClose={() => dismissNoticeToast()} closeLabel={t('app.dismiss')} className="desktop-notice-toast" testId="desktop-notice" />
}

/** macOS: screen sharing needs the Screen Recording permission, granted in System Settings (the shell opens the page). */
function ScreenPermissionDialog() {
  const { t } = useTranslation()
  return (
    <Modal title={t('voice.share.macPermission')} onClose={closeNoticeDialog}>
      <p>{t('voice.share.macPermissionDetail')}</p>
      <div className="desktop-notice-actions">
        <button className="button primary" onClick={answerNoticeDialog} data-autofocus>{t('voice.share.openSystemSettings')}</button>
        <button className="button" onClick={closeNoticeDialog}>{t('voice.share.notNow')}</button>
      </div>
    </Modal>
  )
}

export function DesktopNotices() {
  const toast = useDesktopNotices((s) => s.toast)
  const dialog = useDesktopNotices((s) => s.dialog)
  useEffect(() => startDesktopNotices(), [])
  return (
    <>
      {toast && <DesktopNoticeToast key={toast.id} notice={toast.notice} />}
      {dialog && <ScreenPermissionDialog />}
    </>
  )
}
