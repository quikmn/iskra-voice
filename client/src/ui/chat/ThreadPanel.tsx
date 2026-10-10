// A thread beside its channel (full screen on phones): the message it started from, its replies, a composer.
import { useEffect, useState } from 'react'
import { roleRank, type Message } from '../../core/protocol'
import { connectionFor, loadHistory, type ServerState } from '../../state/store'
import { closeThread, deleteThread, markThreadRead, renameThread, rememberThreads, useThreads } from '../../state/threads'
import { Composer, MessageList, TypingLine } from '../ChatView'
import { Avatar, Spinner } from '../bits'
import { fullTime, hueFor, messageTime } from '../format'
import { renderMarkdown } from '../markdown'
import { Close, Pencil, Trash } from '../icons'
import { Attachments } from './MessageExtras'
import { PinList, Popover } from './HeaderTools'
import { ArrowLeft, PinIcon, ThreadIcon } from './extraIcons'
import { openProfileCard } from '../../state/profile'
import { useEscapeLayer } from '../layers'

export function ThreadPanel({ server, threadId }: { server: ServerState; threadId: number }) {
  const thread = useThreads((s) => s.threads[server.key]?.[threadId])
  const [root, setRoot] = useState<Message | null | undefined>(undefined)
  const [missing, setMissing] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pinsOpen, setPinsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const online = server.status.state === 'online'
  const messages = server.messages[threadId]
  useEscapeLayer(closeThread)

  // The thread and the message it started from.
  useEffect(() => {
    if (!online) return
    let alive = true
    connectionFor(server.key)?.request('thread.get', { id: threadId })
      .then((r) => {
        if (!alive) return
        rememberThreads(server.key, [r.thread])
        setRoot(r.root)
      })
      .catch(() => alive && setMissing(true))
    return () => {
      alive = false
    }
  }, [server.key, threadId, online])

  useEffect(() => {
    if (online) void loadHistory(server.key, threadId)
  }, [server.key, threadId, online])

  // Reading it clears its unread count, now and whenever the window comes back into focus.
  useEffect(() => {
    if (document.hasFocus()) markThreadRead(server.key, threadId)
    const onFocus = () => markThreadRead(server.key, threadId)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [server.key, threadId, messages])

  const parent = thread ? server.channels.find((c) => c.id === thread.channelId) : undefined
  const me = server.me
  const canWrite = !!me && !!parent && roleRank(me.role) >= roleRank(parent.writeRole)
  const creator = thread ? server.members[thread.createdBy] : undefined
  const canManage = !!me && !!thread && (thread.createdBy === me.accountKey ||
    (roleRank(me.role) >= roleRank('admin') && (!creator || roleRank(me.role) > roleRank(creator.role))))
  // Prefer the live copy of the root message when its channel is loaded.
  const liveRoot = thread ? server.messages[thread.channelId]?.find((m) => m.id === thread.rootId && !m.tempId) : undefined
  const shownRoot = liveRoot ?? root

  async function saveName() {
    const name = renaming?.trim()
    if (!name || !thread || name === thread.name) return setRenaming(null)
    try {
      await renameThread(server.key, thread.id, name)
      setRenaming(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove() {
    try {
      await deleteThread(server.key, threadId)
      closeThread()
    } catch (e) {
      setError((e as Error).message)
      setConfirmDelete(false)
    }
  }

  return (
    <section
      className="side-panel thread-panel"
      aria-label={thread ? `Thread ${thread.name}` : 'Thread'}
      onDragOver={(e) => {
        if (canWrite && e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        if (!canWrite || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('iskra:attach-thread', { detail: [...e.dataTransfer.files] }))
      }}
    >
      <header className="side-panel-header">
        <button className="icon-button panel-back" onClick={closeThread} aria-label="Back to channel"><ArrowLeft /></button>
        <span className="panel-icon"><ThreadIcon /></span>
        {renaming !== null ? (
          <input
            className="thread-rename"
            value={renaming}
            maxLength={100}
            autoFocus
            aria-label="Thread name"
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveName()
              else if (e.key === 'Escape') {
                e.preventDefault()
                setRenaming(null)
              }
            }}
            onBlur={() => void saveName()}
          />
        ) : (
          <div className="panel-title">
            <h2>{thread?.name ?? 'Thread'}</h2>
            {parent && <span className="muted">in #{parent.name}</span>}
          </div>
        )}
        <span className="spacer" />
        {thread && (
          <button className={`icon-button ${pinsOpen ? 'on' : ''}`} onClick={() => setPinsOpen((v) => !v)} aria-label="Pinned in this thread" title="Pinned messages">
            <PinIcon />
          </button>
        )}
        {canManage && renaming === null && !confirmDelete && (
          <>
            <button className="icon-button" onClick={() => setRenaming(thread!.name)} aria-label="Rename thread" title="Rename"><Pencil size={16} /></button>
            <button className="icon-button" onClick={() => setConfirmDelete(true)} aria-label="Delete thread" title="Delete thread"><Trash size={16} /></button>
          </>
        )}
        {confirmDelete && (
          <span className="confirm-inline">
            Delete thread?
            <button className="button danger small" onClick={() => void remove()}>Delete</button>
            <button className="button small" onClick={() => setConfirmDelete(false)}>Keep</button>
          </span>
        )}
        <button className="icon-button panel-close" onClick={closeThread} aria-label="Close thread" title="Close"><Close /></button>
        {pinsOpen && thread && (
          <Popover title={`Pinned in ${thread.name}`} onClose={() => setPinsOpen(false)}>
            <PinList server={server} channelId={thread.id} onJump={() => setPinsOpen(false)} />
          </Popover>
        )}
      </header>
      {error && <div className="banner error">{error}</div>}

      {missing ? (
        <div className="empty-state"><p>This thread isn't available any more.</p></div>
      ) : (
        <>
          <MessageList
            key={threadId}
            server={server}
            channelId={threadId}
            thread
            header={<ThreadStart server={server} root={shownRoot} createdBy={thread?.createdBy} />}
          />
          <TypingLine server={server} channelId={threadId} />
          {canWrite && thread ? (
            <Composer server={server} channelId={threadId} channelName={thread.name} thread placeholder={`Reply in ${short(thread.name)}`} />
          ) : (
            <div className="composer read-only">{thread ? "You can't reply in this thread." : <Spinner />}</div>
          )}
        </>
      )}
    </section>
  )
}

const short = (name: string) => (name.length > 28 ? `${name.slice(0, 27).trimEnd()}…` : name)

/** The message the thread started from, at the top of the thread. */
function ThreadStart({ server, root, createdBy }: { server: ServerState; root: Message | null | undefined; createdBy?: string }) {
  if (root === undefined) return <div className="thread-start"><Spinner /></div>
  const starter = createdBy ? server.members[createdBy]?.name ?? 'Someone' : null
  if (root === null) {
    return (
      <div className="thread-start">
        <p className="muted">The original message was deleted.</p>
        {starter && <p className="muted">{starter} started this thread.</p>}
      </div>
    )
  }
  const name = server.members[root.author]?.name ?? 'Former member'
  return (
    <div className="thread-start">
      <div className="thread-root">
        <Avatar name={name} accountKey={root.author} size={36} />
        <div className="message-body">
          <div className="message-meta">
            {server.members[root.author] ? (
              <button className="author" style={{ color: `hsl(${hueFor(root.author)} 70% var(--name-l))` }} onClick={(e) => openProfileCard(server.key, root.author, e.currentTarget)}>{name}</button>
            ) : (
              <span className="author" style={{ color: `hsl(${hueFor(root.author)} 70% var(--name-l))` }}>{name}</span>
            )}
            <time title={fullTime(root.createdAt)}>{messageTime(root.createdAt)}</time>
          </div>
          {root.text && (
            <div className="message-text">
              {renderMarkdown(root.text, { nameOf: (k) => server.members[k]?.name ?? null, me: server.me?.accountKey })}
            </div>
          )}
          <Attachments server={server} files={root.attachments} />
        </div>
      </div>
      {starter && <p className="muted thread-started-by">{starter} started this thread. Replies show up here.</p>}
    </div>
  )
}
