// "Alex saved a clip": the notice a clip leaves in the voice channel's chat. Like a pin note, not a message; only a
// moderator (never the person who saved it) can remove it.
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { connectionFor, type PendingMessage, type ServerState } from '../../state/store'
import { useServerRoles } from '../../state/roles'
import { canDeleteMessage } from '../../state/permissions'
import { fullTime, messageTime } from '../format'
import { Trash } from '../icons'
import { ClipIcon } from './clipIcons'
import './clips.css'

export function ClipNoticeRow({ server, message }: { server: ServerState; message: PendingMessage }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const [error, setError] = useState<string | null>(null)
  const name = server.members[message.author]?.name ?? t('common.someone')
  const mine = message.author === server.me?.accountKey
  const canRemove = !mine && canDeleteMessage(server.me, message, server.members[message.author], roles)

  async function remove() {
    try {
      await connectionFor(server.key)?.request('chat.delete', { id: message.id })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="pin-note clip-notice" role="note" id={`msg-${message.id}`}>
      <span className="clip-notice-icon"><ClipIcon size={15} /></span>
      <span><Trans i18nKey="clips.notice" values={{ name }} components={{ b: <strong /> }} /></span>
      <time className="muted" title={fullTime(message.createdAt)}>{messageTime(message.createdAt)}</time>
      {canRemove && (
        <button className="icon-button small clip-notice-remove" onClick={() => void remove()} aria-label={t('clips.removeNotice')} title={t('clips.removeNotice')}>
          <Trash size={14} />
        </button>
      )}
      {error && <span className="error-text">{error}</span>}
    </div>
  )
}
