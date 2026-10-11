// Pin and thread pieces inside the message list: action buttons, the "N replies" line under a message,
// the "X pinned a message" note, and the bar shown while looking at older messages.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { Message } from '../../core/protocol'
import type { PendingMessage, ServerState } from '../../state/store'
import { setPinned, type PinNote } from '../../state/pins'
import { relativeTime } from './pinThreadHelpers'
import { pinThreadAbilities } from './abilities'
import { createThread, openThread } from '../../state/threads'
import { channelConv, useRead } from '../../state/readState'
import { jumpToMessage } from '../../state/jump'
import { Modal } from '../bits'
import { fullTime, messageTime } from '../format'
import { plainText } from '../markdown'
import { ArrowDown, PinIcon, PinOffIcon, ThreadIcon } from './extraIcons'

export function PinnedMark() {
  const { t } = useTranslation()
  return <span className="pinned-mark" title={t('chat.pins.pinned')} aria-label={t('chat.pins.pinned')}><PinIcon size={13} /></span>
}

/** Extra hover actions on a message: pin/unpin and start a thread. */
export function MessageMenuExtras({ server, message }: { server: ServerState; message: PendingMessage }) {
  const [naming, setNaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { t } = useTranslation()
  if (message.tempId) return null
  const { pinnable, threadable } = pinThreadAbilities(server, message)
  return (
    <>
      {pinnable && (
        <button
          onClick={() => {
            setError(null)
            setPinned(server.key, message, !message.pinned).catch((e: Error) => {
              setError(errorMessage(e))
              setTimeout(() => setError(null), 4000)
            })
          }}
          title={message.pinned ? t('chat.pins.unpin') : t('chat.pins.pin')}
          aria-label={message.pinned ? t('chat.pins.unpinMessage') : t('chat.pins.pinMessage')}
        >
          {message.pinned ? <PinOffIcon size={15} /> : <PinIcon size={15} />}
        </button>
      )}
      {threadable && (
        <button onClick={() => setNaming(true)} title={t('chat.threads.start')} aria-label={t('chat.threads.start')}><ThreadIcon size={15} /></button>
      )}
      {error && <span className="action-error" role="alert">{error}</span>}
      {naming && createPortal(<NewThreadDialog server={server} message={message} onClose={() => setNaming(false)} />, document.body)}
    </>
  )
}

export function NewThreadDialog({ server, message, onClose }: { server: ServerState; message: Message; onClose: () => void }) {
  const suggested = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null }).replace(/\s+/g, ' ').trim().slice(0, 40)
  const { t } = useTranslation()
  const [name, setName] = useState(suggested || t('chat.threads.newThread'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const thread = await createThread(server.key, message, name.trim())
      onClose()
      openThread(server.key, thread.id)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('chat.threads.start')}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" onClick={() => void create()} disabled={!name.trim() || busy}>{t('chat.threads.create')}</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void create() }}>
        <label className="field">
          <span>{t('chat.threads.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus onFocus={(e) => e.target.select()} />
        </label>
        {error && <p className="error-text">{error}</p>}
      </form>
    </Modal>
  )
}

/** Under a message that has a thread: its name, reply count and last activity. */
export function ThreadSummary({ server, message }: { server: ServerState; message: Message }) {
  const thread = message.thread
  const { unread, mentions: pings } = useRead(channelConv(server.key, thread?.id ?? -1))
  const { t } = useTranslation()
  if (!thread) return null
  const replies = thread.messageCount === 0 ? t('chat.threads.noReplies') : t('chat.threads.replies', { count: thread.messageCount })
  return (
    <button className={`thread-summary ${unread ? 'unread' : ''}`} onClick={() => openThread(server.key, thread.id, thread)}>
      <ThreadIcon size={15} />
      <span className="thread-name">{thread.name}</span>
      <span className="thread-count">{replies}</span>
      {thread.lastMessageAt && <span className="muted" title={fullTime(thread.lastMessageAt)}>· {t('chat.threads.lastReply', { when: relativeTime(thread.lastMessageAt) })}</span>}
      {pings > 0 ? <span className="badge">{pings}</span> : unread > 0 ? <span className="thread-unread-dot" aria-label={t('chat.threads.newReplies')} /> : null}
    </button>
  )
}

/** "Viktor pinned a message." Drawn from the pin event, between the messages around when it happened. */
export function PinNoteRow({ server, channelId, note }: { server: ServerState; channelId: number; note: PinNote }) {
  const { t } = useTranslation()
  const who = server.members[note.by]?.name ?? t('common.someone')
  return (
    <div className="pin-note" role="note">
      <span className="pin-note-icon"><PinIcon size={15} /></span>
      <span>
        <Trans i18nKey="chat.pins.note" values={{ name: who }}
          components={{ b: <strong />, link: <button className="link" onClick={() => void jumpToMessage(server.key, channelId, note.messageId)} /> }} />
      </span>
      <time className="muted" title={fullTime(note.at)}>{messageTime(note.at)}</time>
    </div>
  )
}

export function JumpToPresent({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="jump-present">
      <span>{t('chat.jump.older')}</span>
      <button className="link" onClick={onClick}>{t('chat.jump.present')} <ArrowDown size={14} /></button>
    </div>
  )
}
