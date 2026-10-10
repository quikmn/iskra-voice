import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { roleRank, type FileInfo, type Member } from '../core/protocol'
import {
  activeChannelId, connectionFor, discardFailed, loadHistory, notifyTyping, retryAll, retryFailed, sendMessage, uploadFile, useApp,
  type PendingMessage, type ServerState,
} from '../state/store'
import { Attachments, LinkPreviewCard, Reactions, ReactionPicker, ReplyLine } from './chat/MessageExtras'
import { AuthorAvatar, BotBadge, Embeds } from './chat/BotBits'
import { authorOf, sameSender } from './chat/bots'
import { firstLink, formatSize, replyKey, setReply, useReply } from './chat/helpers'
import { Avatar, Spinner } from './bits'
import { openProfileCard } from '../state/profile'
import { decodeMentions, encodeMentions, renderMarkdown } from './markdown'
import { clockTime, fullTime, hueFor, messageTime } from './format'
import type { Panel } from './Shell'
import { Close, FileIcon, Hash, Menu, Paperclip, Pencil, Reply, Send, Smile, Trash, Users, WifiOff } from './icons'
import { HeaderTools } from './chat/HeaderTools'
import { MessageActionSheet } from './chat/MessageActionSheet'
import { useLongPress } from './chat/useLongPress'
import { JumpToPresent, MessageMenuExtras, PinnedMark, PinNoteRow, ThreadSummary } from './chat/PinThreadBits'
import { withPinNotes } from './chat/pinThreadHelpers'
import { jumpToMessage, jumpToPresent, loadNewer, useJumpTarget } from '../state/jump'
import { pinNotesFor, usePinNotes } from '../state/pins'
import { decodeEmoji, encodeEmoji, insertAt } from './expressions/emoji'
import { EmojiPicker } from './expressions/EmojiPicker'
import { useEmojiLookup } from './expressions/useEmojiLookup'
import { useEmojiSuggest } from './expressions/EmojiSuggest'
import { PollCard, PollDialog } from './expressions/Polls'
import { PollIcon } from './expressions/icons'
import { useServerEmojis } from '../state/expressions'

const GROUP_WINDOW_MS = 5 * 60 * 1000

export function ChatView({ server, onToggle }: { server: ServerState; onToggle: (panel: Panel) => void }) {
  const channelId = useApp(activeChannelId)
  const channel = server.channels.find((c) => c.id === channelId)
  const canWrite = !!server.me && !!channel && roleRank(server.me.role) >= roleRank(channel.writeRole)

  useEffect(() => {
    if (channelId !== null && server.status.state === 'online') void loadHistory(server.key, channelId)
  }, [server.key, channelId, server.status.state])

  const [dragging, setDragging] = useState(false)

  return (
    <div
      className={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        setDragging(false)
        if (!canWrite || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('iskra:attach', { detail: [...e.dataTransfer.files] }))
      }}
    >
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
        <HeaderTools key={channel?.id} server={server} channel={channel} />
        <button className="icon-button members-toggle" onClick={() => onToggle('members')} aria-label="Members" title="Members">
          <Users />
        </button>
      </header>

      <ConnectionBanner server={server} />

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
        <div className="empty-state">
          {server.status.state === 'online' ? (
            <>
              <span className="empty-icon"><Hash size={32} /></span>
              <h1>No channels here yet</h1>
              <p>{roleRank(server.me?.role ?? 'guest') >= roleRank('admin') ? 'Create one with the + next to Text channels.' : 'An admin can add some. Check back soon.'}</p>
            </>
          ) : <Spinner />}
        </div>
      )}
    </div>
  )
}

/** Plain words for a server that's away: reconnecting (with a "Try now"), or turned us away. */
function ConnectionBanner({ server }: { server: ServerState }) {
  const { status } = server
  if (status.state === 'rejected') {
    return <div className="banner error" role="alert"><span>{status.message}</span></div>
  }
  if (status.state !== 'offline') return null
  return (
    <div className="banner warn" role="status">
      <WifiOff size={16} />
      <span>Can't reach {server.name} right now. Iskra keeps trying in the background.</span>
      <button className="button small" onClick={retryAll}>Try now</button>
    </div>
  )
}

export function MessageList({ server, channelId, header, thread }: { server: ServerState; channelId: number; header?: ReactNode; thread?: boolean }) {
  const messages = server.messages[channelId]
  const hasMore = server.hasMore[channelId]
  const detached = !!server.detached?.[channelId]
  const notes = usePinNotes(pinNotesFor(server.key, channelId))
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
    const event = thread ? 'iskra:edit-last-thread' : 'iskra:edit-last'
    window.addEventListener(event, onEditLast)
    return () => window.removeEventListener(event, onEditLast)
  }, [messages, server.me, thread])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (restore.current) {
      // Loaded older messages: keep what the user was looking at in place.
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top
      restore.current = null
    } else if (stickToBottom.current && !detached) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, detached])
  useJumpTarget(server.key, channelId, scroller, () => (stickToBottom.current = false), messages)

  function onScroll() {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (el.scrollTop < 200 && hasMore && !restore.current) {
      restore.current = { height: el.scrollHeight, top: el.scrollTop }
      void loadHistory(server.key, channelId, true)
    }
    if (detached && el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadNewer(server.key, channelId)
  }

  const rendered = useMemo(() => {
    if (!messages) return null
    return messages.map((message, i) => {
      const prev = messages[i - 1]
      const grouped = !!prev && sameSender(prev, message) && message.createdAt - prev.createdAt < GROUP_WINDOW_MS && !prev.pending
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
    <>
    <div className="messages" ref={scroller} onScroll={onScroll}>
      {!hasMore && (header ?? (
        <div className="channel-start">
          <span className="channel-start-icon" aria-hidden><Hash size={32} /></span>
          <p className="channel-start-title">Welcome to #{server.channels.find((c) => c.id === channelId)?.name ?? 'this channel'}</p>
          <p>This is the start of the channel. Say hi! 👋</p>
        </div>
      ))}
      {withPinNotes(rendered, notes).map(({ message, grouped, note }) => note ? (
        <PinNoteRow key={`pin-${note.messageId}-${note.at}`} server={server} channelId={channelId} note={note} />
      ) : (
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
    {detached && (
      <JumpToPresent onClick={() => {
        stickToBottom.current = true
        void jumpToPresent(server.key, channelId)
      }} />
    )}
    </>
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
  const shown = authorOf(message, server.members)
  const name = shown.name
  const canOpenProfile = !message.webhook && !!server.members[message.author]
  const me = server.me
  const mine = me?.accountKey === message.author
  const canDelete = !!me && !message.tempId &&
    (mine || (roleRank(me.role) >= roleRank('admin') && (!author || roleRank(me.role) > roleRank(author.role))))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [picking, setPicking] = useState(false)
  const [sheet, setSheet] = useState(false)
  const canEdit = mine && !!message.text && !message.poll
  const longPress = useLongPress(() => setSheet(true), !message.tempId && !editing)
  const [error, setError] = useState<string | null>(null)
  const emojiLookup = useEmojiLookup(server.key)

  function jumpTo(id: number) {
    void jumpToMessage(server.key, message.channelId, id)
  }

  async function remove() {
    try {
      await connectionFor(server.key)?.request('chat.delete', { id: message.id })
    } catch (e) {
      setError((e as Error).message)
    }
    setConfirmDelete(false)
  }

  return (
    <div
      id={message.tempId ? undefined : `msg-${message.id}`}
      className={`message ${grouped && !message.replyTo ? 'grouped' : ''} ${message.pending ?? ''} ${sheet ? 'pressed' : ''}`}
      {...longPress}
    >
      <div className="message-gutter">
        {grouped ? (
          <time className="hover-time" title={fullTime(message.createdAt)}>{clockTime(message.createdAt)}</time>
        ) : canOpenProfile ? (
          <button className="avatar-button" onClick={(e) => openProfileCard(server.key, message.author, e.currentTarget)} aria-label={`Profile of ${name}`}>
            <AuthorAvatar server={server} author={shown} hueKey={message.author} />
          </button>
        ) : (
          <AuthorAvatar server={server} author={shown} hueKey={message.author} />
        )}
      </div>
      <div className="message-body">
        {message.replyTo && <ReplyLine server={server} reply={message.replyTo} onJump={jumpTo} />}
        {(!grouped || message.replyTo) && (
          <div className="message-meta">
            {canOpenProfile ? (
              <button className="author" style={{ color: `hsl(${hueFor(message.author)} 70% var(--name-l))` }} onClick={(e) => openProfileCard(server.key, message.author, e.currentTarget)}>{name}</button>
            ) : (
              <span className="author" style={{ color: `hsl(${hueFor(message.author)} 70% var(--name-l))` }}>{name}</span>
            )}
            {shown.bot && <BotBadge />}
            <time title={fullTime(message.createdAt)}>{messageTime(message.createdAt)}</time>
            {message.pinned && <PinnedMark />}
          </div>
        )}
        {editing ? (
          <EditBox server={server} message={message} onDone={() => onEdit(false)} />
        ) : (
          (message.text || message.editedAt) && !message.poll && (
            <div className="message-text">
              {renderMarkdown(message.text, { nameOf: (k) => server.members[k]?.name ?? null, me: me?.accountKey, emoji: emojiLookup })}
              {message.editedAt && <span className="edited" title={fullTime(message.editedAt)}> (edited)</span>}
            </div>
          )
        )}
        {message.poll && <PollCard server={server} message={message} />}
        <Attachments server={server} files={message.attachments} />
        {message.webhook && <Embeds server={server} embeds={message.webhook.embeds} />}
        {!message.tempId && firstLink(message.text) && <LinkPreviewCard server={server} url={firstLink(message.text)!} />}
        <Reactions server={server} message={message} />
        <ThreadSummary server={server} message={message} />
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
      {!editing && !message.tempId && (
        <div className={`message-actions ${picking ? 'open' : ''}`}>
          {confirmDelete ? (
            <>
              <span>Delete?</span>
              <button className="danger" onClick={() => void remove()}>Yes</button>
              <button onClick={() => setConfirmDelete(false)}>No</button>
            </>
          ) : (
            <>
              <button onClick={() => setPicking((p) => !p)} title="Add reaction" aria-label="Add reaction"><Smile size={15} /></button>
              <button onClick={() => setReply(server.key, message.channelId, message)} title="Reply" aria-label="Reply"><Reply size={15} /></button>
              <MessageMenuExtras server={server} message={message} />
              {canEdit && <button onClick={() => onEdit(true)} title="Edit" aria-label="Edit"><Pencil size={15} /></button>}
              {canDelete && <button onClick={() => setConfirmDelete(true)} title="Delete" aria-label="Delete"><Trash size={15} /></button>}
            </>
          )}
          {picking && <ReactionPicker server={server} message={message} onClose={() => setPicking(false)} />}
        </div>
      )}
      {sheet && (
        <MessageActionSheet server={server} message={message} canEdit={canEdit} canDelete={canDelete} onEdit={() => onEdit(true)} onClose={() => setSheet(false)} />
      )}
    </div>
  )
}

function EditBox({ server, message, onDone }: { server: ServerState; message: PendingMessage; onDone: () => void }) {
  const original = decodeEmoji(decodeMentions(message.text, (k) => server.members[k]?.name ?? null))
  const emojis = useServerEmojis(server.key)
  const [text, setText] = useState(original)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const trimmed = text.trim()
    if (!trimmed || trimmed === original) return onDone()
    try {
      await connectionFor(server.key)?.request('chat.edit', { id: message.id, text: encodeEmoji(encodeMentions(trimmed, Object.values(server.members)), emojis) })
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
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          }
        }}
      />
      <div className="edit-hint">
        Enter to save · Esc to cancel {error && <span className="error-text">· {error}</span>}
      </div>
    </div>
  )
}

interface PendingUpload {
  localId: string
  file: File
  preview: string | null
  progress: number
  result: FileInfo | null
  error: string | null
  abort: AbortController
}

export function Composer({ server, channelId, channelName, thread, placeholder }: {
  server: ServerState
  channelId: number
  channelName: string
  thread?: boolean
  placeholder?: string
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [uploads, setUploads] = useState<PendingUpload[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const [pollOpen, setPollOpen] = useState(false)
  const emojis = useServerEmojis(server.key)
  const replyTo = useReply((s) => s.replyTo[replyKey(server.key, channelId)] ?? null)
  const text = drafts[channelId] ?? ''
  const online = server.status.state === 'online'
  const setText = (value: string) => setDrafts((d) => ({ ...d, [channelId]: value }))
  const uploading = uploads.some((u) => !u.result && !u.error)
  const ready = uploads.filter((u) => u.result).map((u) => u.result!)
  const canSend = online && !uploading && (text.trim().length > 0 || ready.length > 0)

  function addFiles(files: File[]) {
    for (const file of files.slice(0, 10)) {
      const item: PendingUpload = {
        localId: `${Date.now()}-${Math.random()}`, file, progress: 0, result: null, error: null, abort: new AbortController(),
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      }
      setUploads((list) => [...list, item])
      const update = (patch: Partial<PendingUpload>) =>
        setUploads((list) => list.map((u) => (u.localId === item.localId ? { ...u, ...patch } : u)))
      uploadFile(server.key, file, (progress) => update({ progress }), item.abort.signal)
        .then((result) => update({ result, progress: 1 }))
        .catch((e: Error) => e.name !== 'AbortError' && update({ error: e.message }))
    }
  }

  function removeUpload(item: PendingUpload) {
    item.abort.abort()
    if (item.preview) URL.revokeObjectURL(item.preview)
    setUploads((list) => list.filter((u) => u.localId !== item.localId))
  }

  useEffect(() => {
    const onAttach = (e: Event) => addFiles((e as CustomEvent<File[]>).detail)
    const event = thread ? 'iskra:attach-thread' : 'iskra:attach'
    window.addEventListener(event, onAttach)
    return () => window.removeEventListener(event, onAttach)
  })

  // @mention autocomplete: the word being typed after "@".
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const query = /(?:^|\s)@([^\s@]{0,32})$/u.exec(text.slice(0, caret))?.[1]
  const suggestions = query === undefined ? [] : Object.values(server.members)
    .filter((m) => m.name.toLowerCase().startsWith(query.toLowerCase()) && m.accountKey !== server.me?.accountKey)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .slice(0, 6)
  const emojiSuggest = useEmojiSuggest(server.key, text, caret, (next) => {
    setText(next.text)
    setCaret(next.caret)
  })

  function insertMention(name: string) {
    const before = text.slice(0, caret).replace(/@([^\s@]{0,32})$/u, `@${name} `)
    setText(before + text.slice(caret))
    setCaret(before.length)
    setPick(0)
  }

  function submit() {
    if (!canSend) return
    const trimmed = encodeEmoji(encodeMentions(text.trim(), Object.values(server.members)), emojis)
    setText('')
    for (const u of uploads) if (u.preview) URL.revokeObjectURL(u.preview)
    setUploads([])
    setReply(server.key, channelId, null)
    const send = () => void sendMessage(server.key, channelId, trimmed, { attachments: ready, replyTo })
    // Looking at older messages after a jump: go back to the present first.
    if (server.detached?.[channelId]) void jumpToPresent(server.key, channelId).then(send)
    else send()
  }

  return (
    <div className="composer-wrap">
      {replyTo && (
        <div className="reply-bar">
          <span>Replying to <strong>{server.members[replyTo.author]?.name ?? 'someone'}</strong></span>
          <button className="icon-button small" onClick={() => setReply(server.key, channelId, null)} aria-label="Cancel reply"><Close size={14} /></button>
        </div>
      )}
      {uploads.length > 0 && (
        <div className="pending-uploads">
          {uploads.map((u) => (
            <div key={u.localId} className={`pending-upload ${u.error ? 'failed' : ''}`} title={u.error ?? u.file.name}>
              {u.preview ? <img src={u.preview} alt="" /> : <span className="file-icon" aria-hidden><FileIcon size={20} /></span>}
              <span className="file-name">{u.file.name}</span>
              <span className="muted">{u.error ? 'Failed' : u.result ? formatSize(u.file.size) : `${Math.round(u.progress * 100)}%`}</span>
              {!u.result && !u.error && <span className="upload-progress" style={{ width: `${u.progress * 100}%` }} />}
              <button className="icon-button small" onClick={() => removeUpload(u)} aria-label={`Remove ${u.file.name}`}><Close size={14} /></button>
            </div>
          ))}
        </div>
      )}
    <div className="composer">
      <button className="icon-button attach-button" onClick={() => fileInput.current?.click()} aria-label="Attach files" title="Attach files" disabled={!online}>
        <Paperclip />
      </button>
      <button className="icon-button attach-button" onClick={() => setPollOpen(true)} aria-label="Create a poll" title="Create a poll" disabled={!online}>
        <PollIcon />
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      {emojiSuggest.popup}
      {suggestions.length > 0 && (
        <div className="mention-popup" role="listbox" aria-label="Mention someone">
          {suggestions.map((m, i) => (
            <button
              key={m.accountKey}
              role="option"
              aria-selected={i === pick % suggestions.length}
              className={i === pick % suggestions.length ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                insertMention(m.name)
              }}
            >
              <Avatar name={m.name} accountKey={m.accountKey} size={24} online={m.online} />
              {m.name}
            </button>
          ))}
        </div>
      )}
      <AutoTextarea
        key={channelId}
        value={text}
        onCaret={setCaret}
        autoFocus
        placeholder={online ? (placeholder ?? `Message #${channelName}`) : 'Reconnecting…'}
        maxLength={4000}
        onChange={(value) => {
          setText(value)
          if (value) notifyTyping(server.key, channelId)
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files]
          if (files.length) {
            e.preventDefault()
            addFiles(files)
          }
        }}
        onKeyDown={(e) => {
          if (emojiSuggest.onKeyDown(e)) return
          if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
          } else if (suggestions.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault()
            insertMention(suggestions[pick % suggestions.length].name)
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          } else if (e.key === 'ArrowUp' && !text) {
            e.preventDefault()
            window.dispatchEvent(new Event(thread ? 'iskra:edit-last-thread' : 'iskra:edit-last'))
          } else if (e.key === 'Escape' && replyTo) {
            e.preventDefault()
            setReply(server.key, channelId, null)
          }
        }}
      />
      <button className="icon-button attach-button" onClick={(e) => setPicker(picker ? null : e.currentTarget)} aria-label="Emoji" title="Emoji">
        <Smile />
      </button>
      <button className="send-button" onClick={submit} disabled={!canSend} aria-label="Send">
        <Send />
      </button>
    </div>
      {picker && (
        <EmojiPicker
          serverKey={server.key}
          anchor={picker}
          keepOpen
          onClose={() => setPicker(null)}
          onPick={(value) => {
            const next = insertAt(text, caret, decodeEmoji(value))
            setText(next.text)
            setCaret(next.caret)
          }}
        />
      )}
      {pollOpen && <PollDialog server={server} channelId={channelId} onClose={() => setPollOpen(false)} />}
    </div>
  )
}

function AutoTextarea({
  value, onChange, onKeyDown, onPaste, onCaret, placeholder, autoFocus, maxLength,
}: {
  value: string
  onChange: (v: string) => void
  onCaret?: (position: number) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
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
      onChange={(e) => {
        onChange(e.target.value)
        onCaret?.(e.target.selectionStart)
      }}
      onSelect={(e) => onCaret?.(e.currentTarget.selectionStart)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  )
}

export function TypingLine({ server, channelId }: { server: ServerState; channelId: number }) {
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
