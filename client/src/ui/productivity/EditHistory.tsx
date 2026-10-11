// "(edited)" on a message, and its earlier versions for the author and moderators (the server keeps them for channel
// messages; deleting a message deletes them too).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message, MessageVersion } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { connectionFor, type ServerState } from '../../state/store'
import { useServerRoles } from '../../state/roles'
import { has } from '../../state/permissions'
import { Modal, Spinner } from '../bits'
import { fullTime } from '../format'
import { renderMarkdown } from '../markdown'
import { whenText } from './WhenPicker'
import './productivity.css'

export function EditedMark({ server, message }: { server: ServerState; message: Message }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const [open, setOpen] = useState(false)
  if (!message.editedAt) return null
  const canSee = message.author === server.me?.accountKey || has(server.me, roles, 'manageMessages')
  if (!canSee) return <span className="edited" title={fullTime(message.editedAt)}> {t('productivity.history.edited')}</span>
  return (
    <>
      {' '}
      <button className="edited edited-button" title={`${fullTime(message.editedAt)} · ${t('productivity.history.show')}`} onClick={() => setOpen(true)}>
        {t('productivity.history.edited')}
      </button>
      {open && <EditHistoryDialog server={server} message={message} onClose={() => setOpen(false)} />}
    </>
  )
}

function EditHistoryDialog({ server, message, onClose }: { server: ServerState; message: Message; onClose: () => void }) {
  const { t } = useTranslation()
  const [versions, setVersions] = useState<MessageVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nameOf = (k: string) => server.members[k]?.name ?? null

  useEffect(() => {
    let live = true
    connectionFor(server.key)?.request('chat.edits', { id: message.id })
      .then((r) => live && setVersions(r.versions))
      .catch((e) => live && setError(errorMessage(e)))
    return () => {
      live = false
    }
  }, [server.key, message.id, message.editedAt])

  return (
    <Modal title={t('productivity.history.title')} onClose={onClose} className="history-dialog">
      {error ? <p className="error-text" role="alert">{error}</p> : !versions ? <Spinner /> : (
        <ol className="history-list">
          <li className="history-item current">
            <span className="history-when">{t('productivity.history.current')} · {whenText(message.editedAt ?? message.createdAt)}</span>
            <div className="message-text">{renderMarkdown(message.text, { nameOf })}</div>
          </li>
          {[...versions].reverse().map((v, i) => (
            <li key={`${v.at}-${i}`} className="history-item">
              <span className="history-when">
                {i === versions.length - 1 && v.at === message.createdAt ? t('productivity.history.original') : t('productivity.history.version')}
                {' · '}{whenText(v.at)}
              </span>
              <div className="message-text">{renderMarkdown(v.text, { nameOf })}</div>
            </li>
          ))}
          {versions.length === 0 && <li className="muted">{t('productivity.history.none')}</li>}
        </ol>
      )}
    </Modal>
  )
}
