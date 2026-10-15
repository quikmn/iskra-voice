// Channel header tools: threads and pinned messages (popovers) and the search box.
import { ChannelTimerButton } from '../disappear/Timers'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { prepareChannel, readable } from '../../state/e2eeChannels'
import { useTranslation } from 'react-i18next'
import type { Channel, Pin, Thread } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import type { ServerState } from '../../state/store'
import { canPin, loadPins, setPinned, usePinNotes } from '../../state/pins'
import { loadThreads, openThread, useThreads } from '../../state/threads'
import { channelConv, useReads } from '../../state/readState'
import { openSearch, runSearch, setSearchText, useSearch, closeSearch } from '../../state/search'
import { jumpToMessage } from '../../state/jump'
import { Avatar, Spinner } from '../bits'
import { fullTime, messageTime } from '../format'
import { renderMarkdown } from '../markdown'
import { relativeTime } from './pinThreadHelpers'
import { PinIcon, SearchIcon, ThreadIcon } from './extraIcons'
import { useEscapeLayer, useFocusTrap } from '../layers'
import './chat-extras.css'
import { resolveKey } from '../../state/keyMap'

const INACTIVE_MS = 7 * 24 * 3600 * 1000

export function HeaderTools({ server, channel }: { server: ServerState; channel: Channel | undefined }) {
  const [open, setOpen] = useState<'threads' | 'pins' | null>(null)
  const text = useSearch((s) => s.text)
  const { t } = useTranslation()
  if (!channel || !['text', 'voice', 'stage'].includes(channel.kind)) return null
  const toggle = (which: 'threads' | 'pins') => setOpen((o) => (o === which ? null : which))

  return (
    <div className="header-tools">
      <ChannelTimerButton server={server} channel={channel} />
      {channel.kind === 'text' && (
        <button className={`icon-button ${open === 'threads' ? 'on' : ''}`} onClick={() => toggle('threads')} aria-label={t('chat.header.threads')} title={t('chat.header.threads')} aria-expanded={open === 'threads'}>
          <ThreadIcon />
        </button>
      )}
      <button className={`icon-button ${open === 'pins' ? 'on' : ''}`} onClick={() => toggle('pins')} aria-label={t('chat.header.pins')} title={t('chat.header.pins')} aria-expanded={open === 'pins'}>
        <PinIcon />
      </button>
      <label className="header-search desktop-search">
        <SearchIcon size={15} />
        <input
          type="search"
          placeholder={t('common.search')}
          aria-label={t('chat.search.searchMessages')}
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
      <button className="icon-button mobile-search" onClick={() => openSearch(server.key)} aria-label={t('chat.search.searchMessages')} title={t('common.search')}>
        <SearchIcon />
      </button>
      {open === 'pins' && (
        <Popover title={t('chat.header.pinnedIn', { name: channel.name })} onClose={() => setOpen(null)}>
          <PinList server={server} channelId={channel.id} onJump={() => setOpen(null)} />
        </Popover>
      )}
      {open === 'threads' && (
        <Popover title={t('chat.header.threadsIn', { name: channel.name })} onClose={() => setOpen(null)}>
          <ThreadList server={server} channelId={channel.id} onOpen={() => setOpen(null)} />
        </Popover>
      )}
    </div>
  )
}

export function Popover({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEscapeLayer(onClose)
  useFocusTrap(ref)
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
    <div className="header-popover" role="dialog" aria-label={title} ref={ref} tabIndex={-1}>
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
  const { t } = useTranslation()

  useEffect(() => {
    let alive = true
    // Encrypted channels: the chain and keys are loaded first, so pinned messages decrypt on the device right away.
    Promise.all([loadPins(server.key, channelId), prepareChannel(server.key, channelId).catch(() => {})])
      .then(([list]) => alive && setPins(list.map((p) => ({ ...p, message: readable(server.key, p.message) }))))
      .catch((e: Error) => alive && setError(errorMessage(e)))
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
        <p>{t('chat.pins.empty')}</p>
        <p className="muted">{mayPin ? t('chat.pins.emptyCanPin') : t('chat.pins.emptyCannotPin')}</p>
      </div>
    )
  }
  return (
    <ul className="pin-list">
      {pins.map(({ message, pinnedBy, pinnedAt }) => {
        const author = message.imported?.name ?? (server.members[message.author] ?? server.members[resolveKey(message.author)])?.name ?? t('chat.author.formerMember')
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
                  : <span className="muted">{t('chat.search.attachments', { count: message.attachments.length })}</span>}
              </div>
              <div className="pin-actions">
                <span className="muted" title={fullTime(pinnedAt)}>{t('chat.pins.pinnedBy', { name: server.members[pinnedBy]?.name ?? (pinnedBy.startsWith('webhook:') ? server.name : t('chat.composer.someone')) })}</span>
                <button className="link" onClick={() => {
                  onJump()
                  void jumpToMessage(server.key, channelId, message.id)
                }}>{t('chat.pins.jump')}</button>
                {mayPin && <button className="link danger-link" onClick={() => void setPinned(server.key, message, false).catch(() => undefined)}>{t('chat.pins.unpin')}</button>}
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
  const reads = useReads((s) => s.convs)
  const { t } = useTranslation()

  useEffect(() => {
    loadThreads(server.key, channelId).then(() => setLoaded(true)).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key, channelId])

  const threads = Object.values(all ?? {})
    .filter((th) => th.channelId === channelId)
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))
  const active = threads.filter((th) => now - (th.lastMessageAt ?? th.createdAt) < INACTIVE_MS)
  const older = threads.filter((th) => now - (th.lastMessageAt ?? th.createdAt) >= INACTIVE_MS)

  if (error) return <p className="error-text popover-empty">{error}</p>
  if (!loaded && threads.length === 0) return <div className="popover-empty"><Spinner /></div>
  if (threads.length === 0) {
    return (
      <div className="popover-empty">
        <ThreadIcon size={28} />
        <p>{t('chat.threads.empty')}</p>
        <p className="muted">{t('chat.threads.emptyHint')}</p>
      </div>
    )
  }
  const row = (th: Thread) => {
    const pings = reads[channelConv(server.key, th.id)]?.mentions ?? 0
    const unread = reads[channelConv(server.key, th.id)]?.unread ?? 0
    return (
      <li key={th.id}>
        <button className={`thread-row ${unread ? 'unread' : ''}`} onClick={() => {
          onOpen()
          openThread(server.key, th.id)
        }}>
          <ThreadIcon size={16} />
          <span className="thread-row-text">
            <span className="thread-name">{th.name}</span>
            <span className="muted">
              {t('chat.threads.replies', { count: th.messageCount })}
              {th.lastMessageAt ? ` · ${relativeTime(th.lastMessageAt)}` : ''}
            </span>
          </span>
          {pings > 0 ? <span className="badge">{pings}</span> : unread > 0 ? <span className="thread-unread-dot" aria-label={t('chat.threads.newReplies')} /> : null}
        </button>
      </li>
    )
  }
  return (
    <>
      <ul className="thread-list">{active.map(row)}</ul>
      {active.length === 0 && <p className="muted popover-note">{t('chat.threads.noRecent')}</p>}
      {older.length > 0 && (
        <>
          <button className="link-like older-toggle" onClick={() => setShowOlder((v) => !v)} aria-expanded={showOlder}>
            {showOlder ? '▾' : '▸'} {t('chat.threads.older', { n: older.length })}
          </button>
          {showOlder && <ul className="thread-list">{older.map(row)}</ul>}
        </>
      )}
    </>
  )
}
