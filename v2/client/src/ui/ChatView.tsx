import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { roleRank, type Member } from '../core/protocol'
import {
  activeChannelId, connectionFor, discardFailed, loadHistory, notifyTyping, retryFailed, sendMessage, useApp,
  type PendingMessage, type ServerState,
} from '../state/store'
import { Avatar, MessageText, Spinner } from './bits'
import { fullTime, hueFor, messageTime } from './format'
import type { Panel } from './Shell'
import { Hash, Menu, Pencil, Send, Trash, Users } from './icons'

const GROUP_WINDOW_MS = 5 * 60 * 1000

export function ChatView({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const channelId = useApp(activeChannelId)
  const channel = server.channels.find((c) => c.id === channelId)
  const canWrite = !!server.me && !!channel && roleRank(server.me.role) >= roleRank(channel.writeRole)

  useEffect(() => {
    if (channelId !== null && server.status.state === 'online') void loadHistory(server.key, channelId)
  }, [server.key, channelId, server.status.state])

  return (
    <div className="chat">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label="Open channels">
          <Menu />
        </button>
        {channel ? (
          <h1>
            <span className="hash"><Hash size={20} /></span>
            {channel.name}
          </h1>
        ) : (
          <h1>{server.name}</h1>
        )}
        <span className="spacer" />
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label="Members" title="Members">
          <Users />
        </button>
      </header>

      {server.status.state === 'rejected' && (
        <div className="banner error">
          {server.status.message}
        </div>
      )}

      {channel ? (
        <>
          <MessageList key={channel.id} server={server} channelId={channel.id} />
          <TypingLine server={server} channelId={channel.id} />
          {canWrite ? (
            <Composer server={server} channelId={channel.id} channelName={channel.name} />
          ) : (
            <div className="composer read-only">You can't send messages in this channel.</div>
          )}
        </>
      ) : (
        <div className="empty-state">{server.status.state === 'online' ? <p>No channels yet.</p> : <Spinner />}</div>
      )}
    </div>
  )
}

function MessageList({ server, channelId }: { server: ServerState; channelId: number }) {
  const messages = server.messages[channelId]
  const hasMore = server.hasMore[channelId]
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const restore = useRef<{ height: number; top: number } | null>(null)
  const [editing, setEditing] = useState<number | null>(null)

  // Up-arrow in an empty composer edits your last message.
  useEffect(() => {
    const onEditLast = () => {
      const mine = messages?.filter((m) => !m.tempId && m.author === server.me?.accountKey).at(-1)
      if (mine) setEditing(mine.id)
    }
    window.addEventListener('iskra:edit-last', onEditLast)
    return () => window.removeEventListener('iskra:edit-last', onEditLast)
  }, [messages, server.me])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (restore.current) {
      // Loaded older messages: keep what the user was looking at in place.
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top
      restore.current = null
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  function onScroll() {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (el.scrollTop < 200 && hasMore && !restore.current) {
      restore.current = { height: el.scrollHeight, top: el.scrollTop }
      void loadHistory(server.key, channelId, true)
    }
  }

  const rendered = useMemo(() => {
    if (!messages) return null
    return messages.map((message, i) => {
      const prev = messages[i - 1]
      const grouped = !!prev && prev.author === message.author && message.createdAt - prev.createdAt < GROUP_WINDOW_MS && !prev.pending
      return { message, grouped }
    })
  }, [messages])

  if (!rendered) {
    return (
      <div className="messages loading">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      {!hasMore && (
        <div className="channel-start">
          <h2>Welcome to the start of the channel.</h2>
          <p>This is where it all begins. Say hi! 👋</p>
        </div>
      )}
      {rendered.map(({ message, grouped }) => (
        <MessageRow
          key={message.tempId ?? message.id}
          server={server}
          message={message}
          grouped={grouped}
          editing={editing === message.id}
          onEdit={(on) => setEditing(on ? message.id : null)}
        />
      ))}
    </div>
  )
}

function MessageRow({
  server, message, grouped, editing, onEdit,
}: {
  server: ServerState
  message: PendingMessage
  grouped: boolean
  editing: boolean
  onEdit: (on: boolean) => void
}) {
  const author: Member | undefined = server.members[message.author]
  const name = author?.name ?? 'Former member'
  const me = server.me
  const mine = me?.accountKey === message.author
  const canDelete = !!me && !message.tempId &&
    (mine || (roleRank(me.role) >= roleRank('admin') && (!author || roleRank(me.role) > roleRank(author.role))))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    try {
      await connectionFor(server.key)?.request('chat.delete', { id: message.id })
    } catch (e) {
      setError((e as Error).message)
    }
    setConfirmDelete(false)
  }

  return (
    <div className={`message ${grouped ? 'grouped' : ''} ${message.pending ?? ''}`}>
      <div className="message-gutter">
        {grouped ? (
          <time className="hover-time" title={fullTime(message.createdAt)}>{messageTime(message.createdAt).replace(/^.* /, '')}</time>
        ) : (
          <Avatar name={name} accountKey={message.author} />
        )}
      </div>
      <div className="message-body">
        {!grouped && (
          <div className="message-meta">
            <span className="author" style={{ color: `hsl(${hueFor(message.author)} 70% 72%)` }}>{name}</span>
            <time title={fullTime(message.createdAt)}>{messageTime(message.createdAt)}</time>
          </div>
        )}
        {editing ? (
          <EditBox server={server} message={message} onDone={() => onEdit(false)} />
        ) : (
          <div className="message-text">
            <MessageText text={message.text} />
            {message.editedAt && <span className="edited" title={fullTime(message.editedAt)}> (edited)</span>}
          </div>
        )}
        {message.pending === 'failed' && (
          <div className="message-failed">
            Couldn't send.{' '}
            <button className="link" onClick={() => void retryFailed(server.key, message.channelId, message)}>Retry</button>
            {' · '}
            <button className="link" onClick={() => discardFailed(server.key, message.channelId, message.tempId!)}>Discard</button>
          </div>
        )}
        {error && <div className="message-failed">{error}</div>}
      </div>
      {!editing && !message.tempId && (mine || canDelete) && (
        <div className="message-actions">
          {confirmDelete ? (
            <>
              <span>Delete?</span>
              <button className="danger" onClick={() => void remove()}>Yes</button>
              <button onClick={() => setConfirmDelete(false)}>No</button>
            </>
          ) : (
            <>
              {mine && <button onClick={() => onEdit(true)} title="Edit" aria-label="Edit"><Pencil size={15} /></button>}
              {canDelete && <button onClick={() => setConfirmDelete(true)} title="Delete" aria-label="Delete"><Trash size={15} /></button>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function EditBox({ server, message, onDone }: { server: ServerState; message: PendingMessage; onDone: () => void }) {
  const [text, setText] = useState(message.text)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const trimmed = text.trim()
    if (!trimmed || trimmed === message.text) return onDone()
    try {
      await connectionFor(server.key)?.request('chat.edit', { id: message.id, text: trimmed })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="edit-box">
      <AutoTextarea
        value={text}
        onChange={setText}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') onDone()
        }}
      />
      <div className="edit-hint">
        Enter to save · Esc to cancel {error && <span className="error-text">· {error}</span>}
      </div>
    </div>
  )
}

function Composer({ server, channelId, channelName }: { server: ServerState; channelId: number; channelName: string }) {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const text = drafts[channelId] ?? ''
  const online = server.status.state === 'online'
  const setText = (value: string) => setDrafts((d) => ({ ...d, [channelId]: value }))

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || !online) return
    setText('')
    void sendMessage(server.key, channelId, trimmed)
  }

  return (
    <div className="composer">
      <AutoTextarea
        key={channelId}
        value={text}
        autoFocus
        placeholder={online ? `Message #${channelName}` : 'Reconnecting…'}
        maxLength={4000}
        onChange={(value) => {
          setText(value)
          if (value) notifyTyping(server.key, channelId)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          } else if (e.key === 'ArrowUp' && !text) {
            e.preventDefault()
            window.dispatchEvent(new Event('iskra:edit-last'))
          }
        }}
      />
      <button className="send-button" onClick={submit} disabled={!text.trim() || !online} aria-label="Send">
        <Send />
      </button>
    </div>
  )
}

function AutoTextarea({
  value, onChange, onKeyDown, placeholder, autoFocus, maxLength,
}: {
  value: string
  onChange: (v: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  autoFocus?: boolean
  maxLength?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}

function TypingLine({ server, channelId }: { server: ServerState; channelId: number }) {
  const [now, setNow] = useState(() => Date.now())
  const entries = server.typing[channelId] ?? {}
  const active = Object.entries(entries).filter(([key, until]) => until > now && key !== server.me?.accountKey)

  useEffect(() => {
    if (active.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active.length])

  const names = active.map(([key]) => server.members[key]?.name ?? 'Someone')
  const text =
    names.length === 0 ? '' : names.length === 1 ? `${names[0]} is typing…`
      : names.length <= 3 ? `${names.join(', ')} are typing…` : 'Several people are typing…'
  return <div className="typing-line" aria-live="polite">{text}</div>
}
