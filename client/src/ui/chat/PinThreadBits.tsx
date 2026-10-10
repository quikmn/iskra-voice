// Pin and thread pieces inside the message list: action buttons, the "N replies" line under a message,
// the "X pinned a message" note, and the bar shown while looking at older messages.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { roleRank, type Message } from '../../core/protocol'
import type { PendingMessage, ServerState } from '../../state/store'
import { canPin, setPinned, type PinNote } from '../../state/pins'
import { relativeTime } from './pinThreadHelpers'
import { createThread, isThreadId, openThread } from '../../state/threads'
import { jumpToMessage } from '../../state/jump'
import { Modal } from '../bits'
import { fullTime, messageTime } from '../format'
import { plainText } from '../markdown'
import { ArrowDown, PinIcon, PinOffIcon, ThreadIcon } from './extraIcons'

export function PinnedMark() {
  return <span className="pinned-mark" title="Pinned" aria-label="Pinned"><PinIcon size={13} /></span>
}

/** Extra hover actions on a message: pin/unpin and start a thread. */
export function MessageMenuExtras({ server, message }: { server: ServerState; message: PendingMessage }) {
  const [naming, setNaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (message.tempId) return null
  const inThread = isThreadId(server, message.channelId)
  const channel = server.channels.find((c) => c.id === message.channelId)
  const canWrite = !!server.me && !!channel && roleRank(server.me.role) >= roleRank(channel.writeRole)
  const pinnable = canPin(server, message.channelId)
  return (
    <>
      {pinnable && (
        <button
          onClick={() => {
            setError(null)
            setPinned(server.key, message, !message.pinned).catch((e: Error) => {
              setError(e.message)
              setTimeout(() => setError(null), 4000)
            })
          }}
          title={message.pinned ? 'Unpin' : 'Pin'}
          aria-label={message.pinned ? 'Unpin message' : 'Pin message'}
        >
          {message.pinned ? <PinOffIcon size={15} /> : <PinIcon size={15} />}
        </button>
      )}
      {!inThread && canWrite && !message.thread && (
        <button onClick={() => setNaming(true)} title="Start a thread" aria-label="Start a thread"><ThreadIcon size={15} /></button>
      )}
      {error && <span className="action-error" role="alert">{error}</span>}
      {naming && createPortal(<NewThreadDialog server={server} message={message} onClose={() => setNaming(false)} />, document.body)}
    </>
  )
}

function NewThreadDialog({ server, message, onClose }: { server: ServerState; message: Message; onClose: () => void }) {
  const suggested = plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null }).replace(/\s+/g, ' ').trim().slice(0, 40)
  const [name, setName] = useState(suggested || 'New thread')
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
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Start a thread"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" onClick={() => void create()} disabled={!name.trim() || busy}>Create thread</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void create() }}>
        <label className="field">
          <span>Thread name</span>
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
  if (!thread) return null
  const unread = server.unread[thread.id] ?? 0
  const pings = server.mentions[thread.id] ?? 0
  const replies = thread.messageCount === 0 ? 'No replies yet' : `${thread.messageCount} ${thread.messageCount === 1 ? 'reply' : 'replies'}`
  return (
    <button className={`thread-summary ${unread ? 'unread' : ''}`} onClick={() => openThread(server.key, thread.id, thread)}>
      <ThreadIcon size={15} />
      <span className="thread-name">{thread.name}</span>
      <span className="thread-count">{replies}</span>
      {thread.lastMessageAt && <span className="muted" title={fullTime(thread.lastMessageAt)}>· last reply {relativeTime(thread.lastMessageAt)}</span>}
      {pings > 0 ? <span className="badge">{pings}</span> : unread > 0 ? <span className="thread-unread-dot" aria-label="New replies" /> : null}
    </button>
  )
}

/** "Viktor pinned a message." Drawn from the pin event, between the messages around when it happened. */
export function PinNoteRow({ server, channelId, note }: { server: ServerState; channelId: number; note: PinNote }) {
  const who = server.members[note.by]?.name ?? 'Someone'
  return (
    <div className="pin-note" role="note">
      <span className="pin-note-icon"><PinIcon size={15} /></span>
      <span>
        <strong>{who}</strong> pinned{' '}
        <button className="link" onClick={() => void jumpToMessage(server.key, channelId, note.messageId)}>a message</button>.
      </span>
      <time className="muted" title={fullTime(note.at)}>{messageTime(note.at)}</time>
    </div>
  )
}

export function JumpToPresent({ onClick }: { onClick: () => void }) {
  return (
    <div className="jump-present">
      <span>You're viewing older messages</span>
      <button className="link" onClick={onClick}>Jump to present <ArrowDown size={14} /></button>
    </div>
  )
}
