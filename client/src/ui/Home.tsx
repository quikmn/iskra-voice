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
import { clockTime, fullTime, hueFor, messageTime } from './format'
import { Lock, Menu, Send, Settings, Users } from './icons'
import { SettingsDialog } from './settings/SettingsDialog'
import type { Panel } from './Shell'
import { CallButtons, CallLogLine, CallPanel } from './calls/Calls'
import { asLog } from '../state/callMachine'
import { VoiceBar } from './VoiceBar'
import { AccountAvatar, AccountStatusText, MeStatusButton } from './presence/Presence'
import { useIsBlocked } from '../state/moderation'
import { BlockedDmBar } from './moderation/Moderation'
import { GroupChat, GroupRows } from './groups/Groups'
import { DmKeyNotice, DmKeyWarning } from './keys/DmKeyNotice'

const GROUP_WINDOW_MS = 5 * 60 * 1000

function HomeMeBar() {
  const profile = useApp((s) => s.profile)
  const identity = useApp((s) => s.identity)
  const [open, setOpen] = useState(false)
  if (!profile || !identity) return null
  return (
    <div className="me-bar">
      <MeStatusButton name={profile.name} accountKey={b64u(identity.account.publicKey)} sub="you" />
      <button className="icon-button" onClick={() => setOpen(true)} aria-label="Settings" title="Settings">
        <Settings />
      </button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </div>
  )
}

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
        <GroupRows onNavigate={onNavigate} />
        <div className="channel-group"><span>Conversations</span></div>
        {peers.length === 0 && <p className="sidebar-hint">Your direct messages show up here. Start one from anyone's profile.</p>}
        {peers.map(([peer, conversation]) => (
          <button
            key={peer}
            className={`channel dm-row ${open.kind === 'dm' && open.peer === peer ? 'active' : ''} ${conversation.unread ? 'unread' : ''}`}
            onClick={() => {
              openConversation(peer)
              onNavigate()
            }}
          >
            <AccountAvatar name={nameOf(peer)} accountKey={peer} size={28} />
            <span className="dm-row-text">
              <span className="channel-name">{nameOf(peer)}</span>
              <AccountStatusText accountKey={peer} className="dm-status" />
            </span>
            {conversation.unread > 0 && <span className="badge">{conversation.unread}</span>}
          </button>
        ))}
      </div>
      <VoiceBar />
      <HomeMeBar />
    </div>
  )
}

export function HomeMain({ onToggle }: { onToggle: (panel: Panel) => void }) {
  const open = useDms((s) => s.open)
  if (open.kind === 'group') return <GroupChat key={open.key} groupKey={open.key} onToggle={onToggle} />
  return open.kind === 'dm' ? <DmView peer={open.peer} onToggle={onToggle} /> : <FriendsView onToggle={onToggle} />
}

function FriendsView({ onToggle }: { onToggle: (panel: Panel) => void }) {
  const friends = useDms((s) => s.friends)
  useApp((s) => s.servers)
  const list = Object.values(friends).sort((a, b) => Number(isOnline(b.accountKey)) - Number(isOnline(a.accountKey)) || nameOf(a.accountKey).localeCompare(nameOf(b.accountKey)))
  const online = list.filter((f) => isOnline(f.accountKey)).length

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
            <span className="empty-icon"><Users size={32} /></span>
            <h1>No friends yet</h1>
            <p>Open someone's profile in a server's member list and choose “Add friend”. Friends show up here wherever you meet them.</p>
          </div>
        ) : (
          <>
            <h3 className="section-title">{online} of {list.length} online</h3>
            {list.map((friend) => <FriendRow key={friend.accountKey} accountKey={friend.accountKey} />)}
          </>
        )}
      </div>
    </div>
  )
}

function FriendRow({ accountKey }: { accountKey: string }) {
  const [confirm, setConfirm] = useState(false)
  const reachable = sharedServers(accountKey).length > 0
  const name = nameOf(accountKey)
  return (
    <div className="friend-row">
      <AccountAvatar name={name} accountKey={accountKey} size={40} />
      <div className="friend-text">
        <strong>{name}</strong>
        <AccountStatusText accountKey={accountKey} fallback className="muted" />
      </div>
      {confirm ? (
        <>
          <button className="button small danger" onClick={() => void removeFriend(accountKey)}>Remove {name}</button>
          <button className="button small" onClick={() => setConfirm(false)}>Keep</button>
        </>
      ) : (
        <>
          <button className="button small" disabled={!reachable} title={reachable ? undefined : "You don't share an online server right now"} onClick={() => openConversation(accountKey)}>
            Message
          </button>
          <button className="button small ghost" onClick={() => setConfirm(true)} aria-label={`Remove ${name} from friends`}>Remove</button>
        </>
      )}
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
  const blocked = useIsBlocked(peer)
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
        <AccountAvatar name={nameOf(peer)} accountKey={peer} size={28} />
        <h1>{nameOf(peer)}</h1>
        <AccountStatusText accountKey={peer} className="muted dm-header-status" />
        <span className="e2e-badge" title="Only you and they can read these messages"><Lock size={13} /> End-to-end encrypted</span>
        <span className="spacer" />
        {!blocked && <CallButtons peer={peer} />}
        <button className="button small" onClick={() => setVerify(true)}>Verify</button>
      </header>
      <CallPanel peer={peer} />
      <DmKeyWarning peer={peer} />

      <div className="messages" ref={scroller}>
        <div className="channel-start">
          <Avatar name={nameOf(peer)} accountKey={peer} size={64} />
          <h2>{nameOf(peer)}</h2>
          <p>This is the start of your conversation with {nameOf(peer)}. Messages are end-to-end encrypted: servers only pass them along.</p>
        </div>
        {messages.map((dm, i) => {
          if (dm.notice) return <DmKeyNotice key={`${dm.from}:${dm.id}`} dm={dm} onVerify={() => setVerify(true)} />
          const prev = messages[i - 1]
          const grouped = !!prev && !prev.notice && prev.from === dm.from && dm.sentAt - prev.sentAt < GROUP_WINDOW_MS && !prev.pending && !prev.error
          return <DmRow key={`${dm.from}:${dm.id}`} dm={dm} grouped={grouped} peer={peer} mine={dm.from === myKey} />
        })}
      </div>

      <div className="typing-line" />
      {blocked ? (
        <BlockedDmBar accountKey={peer} name={nameOf(peer)} />
      ) : reachable ? (
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
        {grouped ? <time className="hover-time" title={fullTime(dm.sentAt)}>{clockTime(dm.sentAt)}</time> : <Avatar name={name} accountKey={dm.from} />}
      </div>
      <div className="message-body">
        {!grouped && (
          <div className="message-meta">
            <span className="author" style={{ color: `hsl(${hueFor(dm.from)} 70% var(--name-l))` }}>{name}</span>
            <time title={fullTime(dm.sentAt)}>{messageTime(dm.sentAt)}</time>
          </div>
        )}
        {asLog(dm.call) && !dm.error ? (
          <CallLogLine call={dm.call} from={dm.from} peer={peer} />
        ) : dm.error && !dm.pending ? (
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

export function SafetyNumberDialog({ me, peer, onClose }: { me: string; peer: string; onClose: () => void }) {
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
