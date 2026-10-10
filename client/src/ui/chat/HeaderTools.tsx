// Channel header tools: threads and pinned messages (popovers) and the search box.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Channel, Pin, Thread } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { canPin, loadPins, setPinned, usePinNotes } from '../../state/pins'
import { loadThreads, openThread, useThreads } from '../../state/threads'
import { openSearch, runSearch, setSearchText, useSearch, closeSearch } from '../../state/search'
import { jumpToMessage } from '../../state/jump'
import { Avatar, Spinner } from '../bits'
import { fullTime, messageTime } from '../format'
import { renderMarkdown } from '../markdown'
import { relativeTime } from './pinThreadHelpers'
import { PinIcon, SearchIcon, ThreadIcon } from './extraIcons'
import { useEscapeLayer } from '../layers'
import './chat-extras.css'

const INACTIVE_MS = 7 * 24 * 3600 * 1000

export function HeaderTools({ server, channel }: { server: ServerState; channel: Channel | undefined }) {
  const [open, setOpen] = useState<'threads' | 'pins' | null>(null)
  const text = useSearch((s) => s.text)
  if (!channel || channel.kind !== 'text') return null
  const toggle = (which: 'threads' | 'pins') => setOpen((o) => (o === which ? null : which))

  return (
    <div className="header-tools">
      <button className={`icon-button ${open === 'threads' ? 'on' : ''}`} onClick={() => toggle('threads')} aria-label="Threads" title="Threads" aria-expanded={open === 'threads'}>
        <ThreadIcon />
      </button>
      <button className={`icon-button ${open === 'pins' ? 'on' : ''}`} onClick={() => toggle('pins')} aria-label="Pinned messages" title="Pinned messages" aria-expanded={open === 'pins'}>
        <PinIcon />
      </button>
      <label className="header-search desktop-search">
        <SearchIcon size={15} />
        <input
          type="search"
          placeholder="Search"
          aria-label="Search messages"
          value={text}
          maxLength={300}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch(server.key)
            else if (e.key === 'Escape' && (text || useSearch.getState().key)) {
              e.preventDefault()
              setSearchText('')
              closeSearch()
            }
          }}
        />
      </label>
      <button className="icon-button mobile-search" onClick={() => openSearch(server.key)} aria-label="Search messages" title="Search">
        <SearchIcon />
      </button>
      {open === 'pins' && (
        <Popover title={`Pinned in #${channel.name}`} onClose={() => setOpen(null)}>
          <PinList server={server} channelId={channel.id} onJump={() => setOpen(null)} />
        </Popover>
      )}
      {open === 'threads' && (
        <Popover title={`Threads in #${channel.name}`} onClose={() => setOpen(null)}>
          <ThreadList server={server} channelId={channel.id} onOpen={() => setOpen(null)} />
        </Popover>
      )}
    </div>
  )
}

export function Popover({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeLayer(onClose)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element
      // Clicks on the toggle buttons are handled by them.
      if (!ref.current?.contains(target) && !target.closest?.('.header-tools > .icon-button')) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])
  return (
    <div className="header-popover" role="dialog" aria-label={title} ref={ref}>
      <header>{title}</header>
      <div className="header-popover-body">{children}</div>
    </div>
  )
}

/** A channel's pinned messages (or a thread's). */
export function PinList({ server, channelId, onJump }: { server: ServerState; channelId: number; onJump: () => void }) {
  const [pins, setPins] = useState<Pin[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const version = usePinNotes((s) => s.version)
  const mayPin = canPin(server, channelId)

  useEffect(() => {
    let alive = true
    loadPins(server.key, channelId)
      .then((list) => alive && setPins(list))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [server.key, channelId, version])

  if (error) return <p className="error-text popover-empty">{error}</p>
  if (!pins) return <div className="popover-empty"><Spinner /></div>
  if (pins.length === 0) {
    return (
      <div className="popover-empty">
        <PinIcon size={28} />
        <p>No pinned messages yet.</p>
        <p className="muted">{mayPin ? 'Pin important messages from their menu so nobody misses them.' : 'Trusted members can pin important messages here.'}</p>
      </div>
    )
  }
  return (
    <ul className="pin-list">
      {pins.map(({ message, pinnedBy, pinnedAt }) => {
        const author = message.imported?.name ?? server.members[message.author]?.name ?? 'Former member'
        return (
          <li key={message.id} className="pin-item">
            <Avatar name={author} accountKey={message.author} size={28} />
            <div className="pin-body">
              <div className="message-meta">
                <span className="author">{author}</span>
                <time title={fullTime(message.createdAt)}>{messageTime(message.createdAt)}</time>
              </div>
              <div className="pin-text">
                {message.text
                  ? renderMarkdown(message.text, { nameOf: (k) => server.members[k]?.name ?? null, me: server.me?.accountKey })
                  : <span className="muted">{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</span>}
              </div>
              <div className="pin-actions">
                <span className="muted" title={fullTime(pinnedAt)}>Pinned by {server.members[pinnedBy]?.name ?? 'someone'}</span>
                <button className="link" onClick={() => {
                  onJump()
                  void jumpToMessage(server.key, channelId, message.id)
                }}>Jump</button>
                {mayPin && <button className="link danger-link" onClick={() => void setPinned(server.key, message, false).catch(() => undefined)}>Unpin</button>}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ThreadList({ server, channelId, onOpen }: { server: ServerState; channelId: number; onOpen: () => void }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOlder, setShowOlder] = useState(false)
  const [now] = useState(() => Date.now())
  const all = useThreads((s) => s.threads[server.key])

  useEffect(() => {
    loadThreads(server.key, channelId).then(() => setLoaded(true)).catch((e: Error) => setError(e.message))
  }, [server.key, channelId])

  const threads = Object.values(all ?? {})
    .filter((t) => t.channelId === channelId)
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))
  const active = threads.filter((t) => now - (t.lastMessageAt ?? t.createdAt) < INACTIVE_MS)
  const older = threads.filter((t) => now - (t.lastMessageAt ?? t.createdAt) >= INACTIVE_MS)

  if (error) return <p className="error-text popover-empty">{error}</p>
  if (!loaded && threads.length === 0) return <div className="popover-empty"><Spinner /></div>
  if (threads.length === 0) {
    return (
      <div className="popover-empty">
        <ThreadIcon size={28} />
        <p>No threads yet.</p>
        <p className="muted">Start one from any message to keep a side conversation tidy.</p>
      </div>
    )
  }
  const row = (t: Thread) => {
    const pings = server.mentions[t.id] ?? 0
    const unread = server.unread[t.id] ?? 0
    return (
      <li key={t.id}>
        <button className={`thread-row ${unread ? 'unread' : ''}`} onClick={() => {
          onOpen()
          openThread(server.key, t.id)
        }}>
          <ThreadIcon size={16} />
          <span className="thread-row-text">
            <span className="thread-name">{t.name}</span>
            <span className="muted">
              {t.messageCount} {t.messageCount === 1 ? 'reply' : 'replies'}
              {t.lastMessageAt ? ` · ${relativeTime(t.lastMessageAt)}` : ''}
            </span>
          </span>
          {pings > 0 ? <span className="badge">{pings}</span> : unread > 0 ? <span className="thread-unread-dot" aria-label="New replies" /> : null}
        </button>
      </li>
    )
  }
  return (
    <>
      <ul className="thread-list">{active.map(row)}</ul>
      {active.length === 0 && <p className="muted popover-note">No recent activity.</p>}
      {older.length > 0 && (
        <>
          <button className="link-like older-toggle" onClick={() => setShowOlder((v) => !v)} aria-expanded={showOlder}>
            {showOlder ? '▾' : '▸'} Older threads ({older.length})
          </button>
          {showOlder && <ul className="thread-list">{older.map(row)}</ul>}
        </>
      )}
    </>
  )
}
