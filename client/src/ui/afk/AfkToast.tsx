// "Moved to AFK": the notice after a server moved you to its AFK channel for being idle.
import { useTranslation } from 'react-i18next'
import { dismissAfkNotice, useAfk } from '../../state/afk'
import { useApp } from '../../state/store'
import { Toast } from '../kit'
import { Moon } from '../icons'

export function AfkToast() {
  const { t } = useTranslation()
  const notice = useAfk((s) => s.notices[s.notices.length - 1])
  const server = useApp((s) => (notice ? s.servers[notice.serverKey] : undefined))
  if (!notice) return null
  const channel = server?.channels.find((c) => c.id === notice.channelId)?.name ?? t('afk.badge')
  const name = server?.name ?? ''
  return (
    <Toast icon={<Moon size={18} />} className="afk-toast" testId="afk-toast"
      title={t('afk.movedTitle', { channel })}
      body={notice.minutes ? t('afk.movedBody', { minutes: notice.minutes, server: name }) : t('afk.movedBodyShort', { server: name })}
      onClose={() => dismissAfkNotice(notice.at)} closeLabel={t('app.dismiss')} />
  )
}
