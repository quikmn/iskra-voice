import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { b64u } from '../core/crypto'
import { safetyNumber } from '../core/dm'
import { useApp } from '../state/store'
import {
  discardDm, isOnline, markRead, nameOf, openConversation, openFriends, removeFriend, sendDm, sharedServers, useDms, type Dm,
} from '../state/dms'
import { Avatar, Modal } from './bits'
import { renderMarkdown } from './markdown'
import { fingerprint } from '../core/connection'
import { fullTime, hueFor, messageTime } from './format'
import { Lock, Menu, Send, Users } from './icons'
import type { Panel } from './Shell'

const GROUP_WINDOW_MS = 5 * 60 * 1000

export function HomeSidebar({ onNavigate }: { onNavigate: () => void }) {
  const conversations = useDms((s) => s.conversations)
  const open = useDms((s) => s.open)
  useApp((s) => s.servers) // re-render when names or presence change
  const peers = Object.entries(conversations)
    .sort(([, a], [, b]) => (b.messages.at(-1)?.sentAt ?? 0) - (a.messages.at(-1)?.sentAt ?? 0))

  return (
    <div className="channel-sidebar">
      <header className="sidebar-header">
        <h2>Direct messages</h2>
      </header>
      <div className="channel-list">
        <button
          className={`channel ${open.kind === 'friends' ? 'active' : ''}`}
          onClick={() => {
            openFriends()
            onNavigate()
          }}
        >
          <span className="hash"><Users size={16} /></span>
          <span className="channel-name">Friends</span>
        </button>
        <div className="channel-group"><span>Conversations</span></div>
        {peers.length === 0 && <p className="sidebar-hint">Messages you send or get show up here.</p>}
        {peers.map(([peer, conversation]) => (
          <button
            key={peer}
            className={`channel dm-row ${open.kind === 'dm' && open.peer === peer ? 'active' : ''} ${conversation.unread ? 'unread' : ''}`}
            onClick={() => {
              openConversation(peer)
              onNavigate()
            }}
          >
            <Avatar name={nameOf(peer)} accountKey={peer} size={28} online={isOnline(peer)} />
            <span className="channel-name">{nameOf(peer)}</span>
            {conversation.unread > 0 && <span className="badge">{conversation.unread}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

export function HomeMain({ onToggle }: { onToggle: (panel: Panel) => void }) {
  const open = useDms((s) => s.open)
  return open.kind === 'dm' ? <DmView peer={open.peer} onToggle={onToggle} /> : <FriendsView onToggle={onToggle} />
}

function FriendsView({ onToggle }: { onToggle: (panel: Panel) => void }) {
  const friends = useDms((s) => s.friends)
  useApp((s) => s.servers)
  const list = Object.values(friends).sort((a, b) => Number(isOnline(b.accountKey)) - Number(isOnline(a.accountKey)) || nameOf(a.accountKey).localeCompare(nameOf(b.accountKey)))

  return (
    <div className="chat">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label="Open menu">
          <Menu />
        </button>
        <h1><span className="hash"><Users size={20} /></span>Friends</h1>
      </header>
      <div className="friends">
        {list.length === 0 ? (
          <div className="empty-state">
            <h1>No friends yet</h1>
            <p>Open someone's profile in a server's member list and choose “Add friend”. Friends show up here wherever you meet them.</p>
          </div>
        ) : (
          list.map((friend) => {
            const reachable = sharedServers(friend.accountKey).length > 0
            return (
              <div key={friend.accountKey} className="friend-row">
                <Avatar name={nameOf(friend.accountKey)} accountKey={friend.accountKey} size={40} online={isOnline(friend.accountKey)} />
                <div className="friend-text">
                  <strong>{nameOf(friend.accountKey)}</strong>
                  <span className="muted">{isOnline(friend.accountKey) ? 'Online' : 'Offline'}</span>
                </div>
                <button className="button" disabled={!reachable} title={reachable ? undefined : "You don't share an online server right now"} onClick={() => openConversation(friend.accountKey)}>
                  Message
                </button>
                <button className="button danger-outline" onClick={() => void removeFriend(friend.accountKey)}>Remove</button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function DmView({ peer, onToggle }: { peer: string; onToggle: (panel: Panel) => void }) {
  const conversation = useDms((s) => s.conversations[peer])
  const identity = useApp((s) => s.identity)
  useApp((s) => s.servers)
  const [verify, setVerify] = useState(false)
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const myKey = identity ? b64u(identity.account.publicKey) : ''
  const reachable = sharedServers(peer).length > 0
  const messages = conversation?.messages ?? []

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  useEffect(() => {
    if (conversation?.unread) markRead(peer)
  }, [conversation?.unread, peer])

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || !reachable) return
    setText('')
    void sendDm(peer, trimmed)
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label="Open menu">
          <Menu />
        </button>
        <Avatar name={nameOf(peer)} accountKey={peer} size={28} online={isOnline(peer)} />
        <h1>{nameOf(peer)}</h1>
        <span className="e2e-badge" title="Only you and they can read these messages"><Lock size={13} /> End-to-end encrypted</span>
        <span className="spacer" />
        <button className="button small" onClick={() => setVerify(true)}>Verify</button>
      </header>

      <div className="messages" ref={scroller}>
        <div className="channel-start">
          <Avatar name={nameOf(peer)} accountKey={peer} size={64} />
          <h2>{nameOf(peer)}</h2>
          <p>This is the start of your conversation. Messages are end-to-end encrypted: servers only pass them along.</p>
        </div>
        {messages.map((dm, i) => {
          const prev = messages[i - 1]
          const grouped = !!prev && prev.from === dm.from && dm.sentAt - prev.sentAt < GROUP_WINDOW_MS && !prev.pending && !prev.error
          return <DmRow key={dm.id} dm={dm} grouped={grouped} peer={peer} mine={dm.from === myKey} />
        })}
      </div>

      <div className="typing-line" />
      {reachable ? (
        <div className="composer">
          <textarea
            rows={1}
            value={text}
            maxLength={4000}
            placeholder={`Message ${nameOf(peer)}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button className="send-button" onClick={submit} disabled={!text.trim()} aria-label="Send">
            <Send />
          </button>
        </div>
      ) : (
        <div className="composer read-only">You don't share an online server with {nameOf(peer)} right now, so messages can't be delivered.</div>
      )}

      {verify && identity && <SafetyNumberDialog me={myKey} peer={peer} onClose={() => setVerify(false)} />}
    </div>
  )
}

function DmRow({ dm, grouped, peer, mine }: { dm: Dm; grouped: boolean; peer: string; mine: boolean }) {
  const name = nameOf(dm.from)
  return (
    <div className={`message ${grouped ? 'grouped' : ''} ${dm.pending ?? ''}`}>
      <div className="message-gutter">
        {grouped ? <time className="hover-time" title={fullTime(dm.sentAt)}>{messageTime(dm.sentAt).replace(/^.* /, '')}</time> : <Avatar name={name} accountKey={dm.from} />}
      </div>
      <div className="message-body">
        {!grouped && (
          <div className="message-meta">
            <span className="author" style={{ color: `hsl(${hueFor(dm.from)} 70% 72%)` }}>{name}</span>
            <time title={fullTime(dm.sentAt)}>{messageTime(dm.sentAt)}</time>
          </div>
        )}
        {dm.error && !dm.pending ? (
          <div className="message-notice"><Lock size={13} /> {dm.error}</div>
        ) : (
          <div className="message-text">{renderMarkdown(dm.text, { nameOf: (k) => nameOf(k) })}</div>
        )}
        {dm.pending === 'failed' && mine && (
          <div className="message-failed">
            {dm.error ?? "Couldn't send."}{' '}
            <button className="link" onClick={() => { discardDm(peer, dm.id); void sendDm(peer, dm.text) }}>Retry</button>
            {' · '}
            <button className="link" onClick={() => discardDm(peer, dm.id)}>Discard</button>
          </div>
        )}
      </div>
    </div>
  )
}

function SafetyNumberDialog({ me, peer, onClose }: { me: string; peer: string; onClose: () => void }) {
  const number = safetyNumber(me, peer)
  return (
    <Modal title={`Verify ${nameOf(peer)}`} onClose={onClose}>
      <p className="muted">
        Compare this number with {nameOf(peer)} in person or on a call. If it matches on both screens, nobody, not even a server, can read or
        fake your messages.
      </p>
      <div className="safety-number">
        {number.split(' ').map((group, i) => <span key={i}>{group}</span>)}
      </div>
      <p className="muted">
        Their ID: <code>{fingerprint(peer)}</code> · Your ID: <code>{fingerprint(me)}</code>
      </p>
    </Modal>
  )
}
