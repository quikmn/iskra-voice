// "Moved to AFK": the notice after a server moved you to its AFK channel for being idle.
import { useTranslation } from 'react-i18next'
import { dismissAfkNotice, useAfk } from '../../state/afk'
import { useApp } from '../../state/store'
import { Close } from '../icons'
import '../update-toast.css'

export function AfkToast() {
  const { t } = useTranslation()
  const notice = useAfk((s) => s.notices[s.notices.length - 1])
  const server = useApp((s) => (notice ? s.servers[notice.serverKey] : undefined))
  if (!notice) return null
  const channel = server?.channels.find((c) => c.id === notice.channelId)?.name ?? t('afk.badge')
  const name = server?.name ?? ''
  return (
    <div className="update-toast afk-toast" role="status" aria-live="polite" data-testid="afk-toast">
      <div className="update-toast-text">
        <strong>{t('afk.movedTitle', { channel })}</strong>
        <span>{notice.minutes ? t('afk.movedBody', { minutes: notice.minutes, server: name }) : t('afk.movedBodyShort', { server: name })}</span>
      </div>
      <button className="icon-button" onClick={() => dismissAfkNotice(notice.at)} aria-label={t('app.dismiss')} title={t('app.dismiss')}>
        <Close size={16} />
      </button>
    </div>
  )
}
