import { DisappearLine, ExpiryBadge } from './disappear/Disappear'
import { DmTimerButton } from './disappear/Timers'
import { useAlertPattern } from '../state/alerts'
import { matchesAlert } from '../state/alertsLogic'
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { b64u } from '../core/crypto'
import { safetyNumber } from '../core/dm'
import { useApp } from '../state/store'
import { discardDm, nameOf, openConversation, openFriends, sendDm, sharedServers, useDms, type Dm } from '../state/dms'
import { useIncomingCount } from '../state/friends'
import { quietKind } from '../state/friendMachine'
import { FriendButtons, FriendLine, FriendsView } from './people/Friends'
import { userMenuProps } from './people/userMenuProps'
import { dividerOf, dividerTarget, dmConv, useRead, useReads } from '../state/readState'
import { UnreadBar, UnreadDivider } from './organize/UnreadBits'
import { Avatar, Modal } from './bits'
import { renderMarkdown } from './markdown'
import { fingerprint } from '../core/connection'
import { clockTime, fullTime, hueFor, messageTime } from './format'
import { Lock, Menu, Settings, ShieldCheck, Users } from './icons'
import { openMySettings } from './settings/open'
import { ForwardedFiles, ForwardedLine } from './organize/ForwardDialog'
import type { Panel } from './Shell'
import { CallButtons, CallLogLine, CallPanel } from './calls/Calls'
import { asLog } from '../state/callMachine'
import { VoiceBar } from './VoiceBar'
import { AccountAvatar, AccountStatusText, MeStatusButton } from './presence/Presence'
import { useIsBlocked } from '../state/moderation'
import { BlockedDmBar } from './moderation/Moderation'
import { GroupChat, GroupRows } from './groups/Groups'
import { DmKeyNotice, DmKeyWarning } from './keys/DmKeyNotice'
import { DM_ATTACH_EVENT, DmAttachments, DmComposer } from './dms/DmFiles'
import { SavedRow } from './productivity/InboxButton'
import { usePrivateMessageTools } from './productivity/MessageTools'
import { dmTarget, privateRowId } from '../state/messageRefs'
import { KeyHistory } from './keys/KeyTransparency'
import { messageListKeys, useAnnounceNew } from './a11y'
import { useBotPeer } from '../state/botDms'
import { BotBadge } from './chat/BotBits'
import { AutoTranslateButton, TranslationBlock } from './translate/Translate'
import { dmItem } from './translate/items'
import { convKey } from '../state/translate'

const GROUP_WINDOW_MS = 5 * 60 * 1000

function HomeMeBar() {
  const { t } = useTranslation()
  const profile = useApp((s) => s.profile)
  const identity = useApp((s) => s.identity)
  if (!profile || !identity) return null
  return (
    <div className="me-bar">
      <MeStatusButton name={profile.name} accountKey={b64u(identity.account.publicKey)} sub={t('common.you')} />
      <button className="icon-button" onClick={() => openMySettings()} aria-label={t('settings.room.mine')} title={t('settings.room.mine')}>
        <Settings />
      </button>
    </div>
  )
}

export function HomeSidebar({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation()
  const conversations = useDms((s) => s.conversations)
  const open = useDms((s) => s.open)
  const reads = useReads((s) => s.convs)
  useApp((s) => s.servers) // re-render when names or presence change
  const incoming = useIncomingCount()
  // Friend requests alone don't make a conversation (they're on the Friends page).
  const lastAt = (messages: Dm[]) => messages.findLast((m) => !m.friend)?.sentAt ?? 0
  const peers = Object.entries(conversations)
    .filter(([peer, c]) => lastAt(c.messages) > 0 || (open.kind === 'dm' && open.peer === peer))
    .sort(([, a], [, b]) => lastAt(b.messages) - lastAt(a.messages))

  return (
    <nav className="channel-sidebar" aria-label={t('app.home.directMessages')}>
      <header className="sidebar-header">
        <h2>{t('app.home.directMessages')}</h2>
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
          <span className="channel-name">{t('app.home.friends')}</span>
          {incoming > 0 && <span className="badge" aria-label={t('friends.pendingBadge', { count: incoming })}>{incoming}</span>}
        </button>
        <SavedRow onNavigate={onNavigate} />
        <GroupRows onNavigate={onNavigate} />
        <div className="channel-group"><span>{t('app.home.conversations')}</span></div>
        {peers.length === 0 && <p className="sidebar-hint">{t('app.home.dmHint')}</p>}
        {peers.map(([peer]) => (
          <button
            key={peer}
            className={`channel dm-row ${open.kind === 'dm' && open.peer === peer ? 'active' : ''} ${reads[dmConv(peer)]?.unread ? 'unread' : ''}`}
            {...userMenuProps(peer)}
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
            {!!reads[dmConv(peer)]?.unread && <span className="badge">{reads[dmConv(peer)].unread}</span>}
          </button>
        ))}
      </div>
      <VoiceBar />
      <HomeMeBar />
    </nav>
  )
}

/** `start`: shown on the Friends page while there are no servers yet (how to join or start one). */
export function HomeMain({ onToggle, start }: { onToggle: (panel: Panel) => void; start?: ReactNode }) {
  const open = useDms((s) => s.open)
  if (open.kind === 'group') return <GroupChat key={open.key} groupKey={open.key} onToggle={onToggle} />
  return open.kind === 'dm' ? <DmView peer={open.peer} onToggle={onToggle} /> : <FriendsView onToggle={onToggle} start={start} />
}

function DmView({ peer, onToggle }: { peer: string; onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const conversation = useDms((s) => s.conversations[peer])
  const identity = useApp((s) => s.identity)
  useApp((s) => s.servers)
  const [verify, setVerify] = useState(false)
  const [dragging, setDragging] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const myKey = identity ? b64u(identity.account.publicKey) : ''
  const reachable = sharedServers(peer).length > 0
  const blocked = useIsBlocked(peer)
  const peerBot = useBotPeer(peer)
  const messages = conversation?.messages ?? []

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const divider = dividerOf(useRead(dmConv(peer)))
  const firstNew = divider && dividerTarget(messages, divider.from, (m) => (m.pending || m.notice || m.friend || m.from === myKey ? null : { id: m.id, at: m.sentAt }))
  useAnnounceNew(conversation?.messages, (m) => (m.pending ? null : `${m.from}:${m.id}`),
    (m) => (m.from === myKey || m.notice || m.friend || m.call ? null : t('chat.a11y.newMessage', { name: nameOf(m.from), text: m.text?.slice(0, 200) || t('chat.message.attachment') })))

  return (
    <div
      className={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!reachable || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        setDragging(false)
        if (!reachable || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent(DM_ATTACH_EVENT, { detail: [...e.dataTransfer.files] }))
      }}
    >
      <header className="chat-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('app.openMenu')}>
          <Menu />
        </button>
        <span className="dm-header-person" {...userMenuProps(peer)}>
          <AccountAvatar name={nameOf(peer)} accountKey={peer} size={28} />
          <h1>{nameOf(peer)}</h1>
          {peerBot.bot && <BotBadge builtin={peerBot.builtin} />}
        </span>
        <AccountStatusText accountKey={peer} className="muted dm-header-status" />
        <span className="e2e-badge" title={t('app.home.e2eTitle')}><Lock size={13} /> {t('app.home.e2e')}</span>
        <span className="spacer" />
        {!peerBot.bot && <DmTimerButton peer={peer} canChange={reachable && !blocked} />}
        {reachable && !peerBot.bot && <span className="dm-header-friend"><FriendButtons accountKey={peer} header /></span>}
        {!blocked && !peerBot.bot && <CallButtons peer={peer} />}
        <AutoTranslateButton conv={convKey.dm(peer)} />
        <button className="button small verify-button" onClick={() => setVerify(true)} aria-label={t('app.home.verify')} title={t('app.home.verify')}>
          <ShieldCheck size={15} /><span className="verify-label">{t('app.home.verify')}</span>
        </button>
      </header>
      <CallPanel peer={peer} />
      <DmKeyWarning peer={peer} />

      <div className="messages" ref={scroller} onKeyDown={messageListKeys} tabIndex={0} role="region" aria-label={t('chat.a11y.messages', { name: nameOf(peer) })}>
        <UnreadBar conv={dmConv(peer)} scroller={scroller} onJump={() => undefined} catchUp={{ spec: { kind: 'dm', peer }, title: nameOf(peer) }} />
        <div className="channel-start">
          <Avatar name={nameOf(peer)} accountKey={peer} size={64} />
          <h2>{nameOf(peer)}</h2>
          <p>{peerBot.bot ? t('dms.bot.start', { name: nameOf(peer) }) : t('app.home.dmStart', { name: nameOf(peer) })}</p>
        </div>
        {messages.map((dm, i) => {
          if (dm.notice) return <DmKeyNotice key={`${dm.from}:${dm.id}`} dm={dm} onVerify={() => setVerify(true)} />
          if (dm.disappear && !dm.error) return <DisappearLine key={`${dm.from}:${dm.id}`} seconds={dm.disappear.seconds} name={nameOf(dm.from)} mine={dm.from === myKey} at={dm.sentAt} />
          if (dm.friend) return quietKind(dm.friend.kind) ? null : <FriendLine key={`${dm.from}:${dm.id}`} dm={dm} mine={dm.from === myKey} />
          const prev = messages[i - 1]
          const grouped = !!prev && !prev.notice && !prev.friend && !prev.disappear && prev.from === dm.from && dm.sentAt - prev.sentAt < GROUP_WINDOW_MS && !prev.pending && !prev.error
          return (
            <Fragment key={`${dm.from}:${dm.id}`}>
              {dm === firstNew && <UnreadDivider />}
              <DmRow dm={dm} grouped={grouped && dm !== firstNew} peer={peer} mine={dm.from === myKey} />
            </Fragment>
          )
        })}
      </div>

      <div className="typing-line" />
      {blocked ? (
        <BlockedDmBar accountKey={peer} name={nameOf(peer)} />
      ) : peerBot.builtin ? (
        <div className="composer read-only">{t('dms.bot.builtin')}</div>
      ) : reachable ? (
        <DmComposer key={peer} peer={peer} bot={peerBot.bot} placeholder={t('app.home.messagePlaceholder', { name: nameOf(peer) })} />
      ) : (
        <div className="composer read-only">{t('app.home.unreachable', { name: nameOf(peer) })}</div>
      )}

      {verify && identity && <SafetyNumberDialog me={myKey} peer={peer} onClose={() => setVerify(false)} />}
    </div>
  )
}

function DmRow({ dm, grouped, peer, mine }: { dm: Dm; grouped: boolean; peer: string; mine: boolean }) {
  const { t } = useTranslation()
  const name = nameOf(dm.from)
  const translateItem = dm.pending || dm.error || asLog(dm.call) ? null : dmItem(peer, dm, (k) => nameOf(k))
  // No saving or reminders for disappearing messages: they would keep a copy of it.
  const tools = usePrivateMessageTools(dm.pending || dm.error || asLog(dm.call) || dm.expiresAt ? null : dmTarget(peer, dm), dm.text, translateItem)
  const alerts = useAlertPattern(null)
  const alerted = !mine && matchesAlert(alerts, dm.text)
  return (
    <div id={privateRowId(dm.from, dm.id)} {...tools.rowProps} data-dm-id={dm.id} className={`message ${grouped ? 'grouped' : ''} ${dm.pending ?? ''} ${tools.rowProps.className ?? ''} ${alerted ? 'alerted' : ''}`}
      role="article" tabIndex={-1} aria-label={t('chat.a11y.message', { name, time: fullTime(dm.sentAt) })}>
      <div className="message-gutter">
        {grouped ? <><time className="hover-time" title={fullTime(dm.sentAt)}>{clockTime(dm.sentAt)}</time>{dm.expiresAt && <ExpiryBadge expiresAt={dm.expiresAt} />}</> : <span {...userMenuProps(dm.from)}><Avatar name={name} accountKey={dm.from} /></span>}
      </div>
      <div className="message-body">
        {!grouped && (
          <div className="message-meta">
            <span className="author" style={{ color: `hsl(${hueFor(dm.from)} 70% var(--name-l))` }} {...userMenuProps(dm.from)}>{name}</span>
            <time title={fullTime(dm.sentAt)}>{messageTime(dm.sentAt)}</time>
            <ExpiryBadge expiresAt={dm.expiresAt} />
          </div>
        )}
        {asLog(dm.call) && !dm.error ? (
          <CallLogLine call={dm.call} from={dm.from} peer={peer} />
        ) : dm.error && !dm.pending ? (
          <div className="message-notice"><Lock size={13} /> {dm.error}</div>
        ) : (
          <>
            {dm.forward && <ForwardedLine label={dm.forward.from} />}
            {dm.text && <div className="message-text">{renderMarkdown(dm.text, { nameOf: (k) => nameOf(k), alerts })}</div>}
            <TranslationBlock item={translateItem} />
            {dm.forward && dm.forward.files.length > 0 && <ForwardedFiles files={dm.forward.files} />}
            <DmAttachments files={dm.files} />
          </>
        )}
        {dm.pending === 'failed' && mine && (
          <div className="message-failed">
            {dm.error ?? t('app.home.couldntSend')}{' '}
            <button className="link" onClick={() => { discardDm(peer, dm.id); void sendDm(peer, dm.text, dm.files ? { files: dm.files } : {}) }}>{t('common.retry')}</button>
            {' · '}
            <button className="link" onClick={() => discardDm(peer, dm.id)}>{t('app.home.discard')}</button>
          </div>
        )}
      </div>
      {tools.tools}
    </div>
  )
}

export function SafetyNumberDialog({ me, peer, onClose }: { me: string; peer: string; onClose: () => void }) {
  const { t } = useTranslation()
  const number = safetyNumber(me, peer)
  return (
    <Modal title={t('app.home.verifyTitle', { name: nameOf(peer) })} onClose={onClose}>
      <p className="muted">{t('app.home.verifyBody', { name: nameOf(peer) })}</p>
      <div className="safety-number">
        {number.split(' ').map((group, i) => <span key={i}>{group}</span>)}
      </div>
      <p className="muted">
        {t('app.home.theirId')} <code>{fingerprint(peer)}</code> · {t('app.home.yourId')} <code>{fingerprint(me)}</code>
      </p>
      <KeyHistory peer={peer} />
    </Modal>
  )
}
