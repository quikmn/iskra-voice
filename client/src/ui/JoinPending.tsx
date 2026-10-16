// Joined through an invite that needs a moderator's approval: the only thing shown until they decide is the server's
// name and icon (from its public `GET /`, like the invite page) and that we're waiting. The connection knocks again by itself.
import { useTranslation } from 'react-i18next'
import { useServerInfo } from '../state/serverName'
import { leaveServer, retryServer, type ServerState } from '../state/store'
import { Spinner } from './bits'
import { initials } from './format'

export function JoinPending({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const info = useServerInfo(server.directUrl)
  const name = info?.name ?? server.name
  return (
    <div className="empty-state join-pending" role="status" data-testid="join-pending">
      <span className="join-pending-icon" aria-hidden>
        {info?.icon ? <img src={info.icon} alt="" draggable={false} /> : initials(name)}
      </span>
      <h1>{t('chat.view.pendingTitle', { name })}</h1>
      <p>{t('chat.view.pendingBody')}</p>
      <p className="muted join-pending-wait"><Spinner /> {t('chat.view.pendingWaiting')}</p>
      <div className="join-failed-actions">
        <button className="button" onClick={() => retryServer(server.key)}>{t('chat.view.tryNow')}</button>
        <button className="button" onClick={() => leaveServer(server.key)}>{t('chat.view.pendingLeave')}</button>
      </div>
    </div>
  )
}
