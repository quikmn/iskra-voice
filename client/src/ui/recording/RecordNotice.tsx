// "Alex started recording this call": the line a recording leaves in the voice channel's chat. Like a clip notice,
// only a moderator (never the recorder) can remove it.
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { connectionFor, type PendingMessage, type ServerState } from '../../state/store'
import { useServerRoles } from '../../state/roles'
import { canDeleteMessage } from '../../state/permissions'
import { fullTime, messageTime } from '../format'
import { Trash } from '../icons'
import '../clips/clips.css'
import './recording.css'

export function RecordNoticeRow({ server, message }: { server: ServerState; message: PendingMessage }) {
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
    <div className="pin-note clip-notice record-notice" role="note" id={`msg-${message.id}`}>
      <span className={`recording-dot ${message.recordNotice?.kind === 'stop' ? 'stopped' : ''}`} aria-hidden />
      <span><Trans i18nKey={message.recordNotice?.kind === 'stop' ? 'recording.chatStop' : 'recording.chatStart'} values={{ name }} components={{ b: <strong /> }} /></span>
      <time className="muted" title={fullTime(message.createdAt)}>{messageTime(message.createdAt)}</time>
      {canRemove && (
        <button className="icon-button small clip-notice-remove" onClick={() => void remove()} aria-label={t('recording.removeNotice')} title={t('recording.removeNotice')}>
          <Trash size={14} />
        </button>
      )}
      {error && <span className="error-text">{error}</span>}
    </div>
  )
}
