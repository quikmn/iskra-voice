// Tells admins when an outgoing webhook kept failing and turned itself off (event outhook.disabled).
import { useTranslation } from 'react-i18next'
import { dismissOuthookNotice, useOuthookNotices } from '../state/outhooks'
import { useApp } from '../state/store'
import { Close } from './icons'
import './update-toast.css'

export function OuthookToast() {
  const { t } = useTranslation()
  const notice = useOuthookNotices((s) => s.notices[0])
  const serverName = useApp((s) => (notice ? s.servers[notice.server]?.name : undefined))
  if (!notice) return null
  return (
    <div className="update-toast outhook-toast" role="status" aria-live="polite" data-testid="outhook-toast">
      <div className="update-toast-text">
        <strong>{t('outhooks.disabledTitle')}</strong>
        <span>{t('outhooks.disabledBody', { name: notice.hook.name, server: serverName ?? '' })}</span>
      </div>
      <button className="icon-button" onClick={() => dismissOuthookNotice(notice.hook.id)} aria-label={t('app.dismiss')} title={t('app.dismiss')}>
        <Close size={16} />
      </button>
    </div>
  )
}
