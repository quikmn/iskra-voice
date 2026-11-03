// Tells admins when an outgoing webhook kept failing and turned itself off (event outhook.disabled).
import { useTranslation } from 'react-i18next'
import { dismissOuthookNotice, useOuthookNotices } from '../state/outhooks'
import { useApp } from '../state/store'
import { AlertTriangle } from './icons'
import { Toast } from './kit'

export function OuthookToast() {
  const { t } = useTranslation()
  const notice = useOuthookNotices((s) => s.notices[0])
  const serverName = useApp((s) => (notice ? s.servers[notice.server]?.name : undefined))
  if (!notice) return null
  return (
    <Toast tone="warning" icon={<AlertTriangle size={18} />} className="outhook-toast" testId="outhook-toast"
      title={t('outhooks.disabledTitle')} body={t('outhooks.disabledBody', { name: notice.hook.name, server: serverName ?? '' })}
      onClose={() => dismissOuthookNotice(notice.hook.id)} closeLabel={t('app.dismiss')} />
  )
}
