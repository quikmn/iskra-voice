// The Friends page (Online, All, Pending), friend buttons for profiles and the DM header, and the small
// "sent you a friend request" line in a DM.
import { useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { isOnline, nameOf, openConversation, sharedServers, type Dm } from '../../state/dms'
import {
  acceptFriend, addFriend, cancelFriendRequest, ignoreFriend, useFriends, useIncomingCount, useRelation, type FriendPeer,
} from '../../state/friends'
import { useIsBlocked } from '../../state/moderation'
import { bestStatus, statusOf } from '../../state/presenceRules'
import { useApp } from '../../state/store'
import { openUserMenu } from '../../state/userMenu'
import { AccountAvatar, AccountStatusText } from '../presence/Presence'
import { Menu, UserPlus, Users } from '../icons'
import type { Panel } from '../Shell'
import { userMenuProps } from './userMenuProps'
import './people.css'

const MoreDots = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
)

/** Runs a friend action, keeping its error for the caller to show. */
function useAction() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<void>) => async () => {
    setBusy(true)
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, run }
}

/**
 * Where you stand with someone, as buttons: Add friend · Request sent (Cancel) · Accept / Ignore · Friends.
 * `header`: the DM header's compact version (nothing once you're friends).
 */
export function FriendButtons({ accountKey, header }: { accountKey: string; header?: boolean }) {
  const { t } = useTranslation()
  const relation = useRelation(accountKey)
  const blocked = useIsBlocked(accountKey)
  const { error, busy, run } = useAction()
  const mine = useApp((s) => s.identity)
  if (blocked || !mine) return null
  const small = header ? 'small' : ''
  return (
    <>
      {relation === 'none' && (
        <button className={`button ${small} ${header ? 'primary' : ''}`} disabled={busy} onClick={run(() => addFriend(accountKey))}>
          {header && <UserPlus size={14} />} {t('friends.add')}
        </button>
      )}
      {relation === 'outgoing' && (
        <>
          <span className="friend-chip">{t('friends.requestSent')}</span>
          <button className={`button ghost ${small}`} disabled={busy} onClick={run(() => cancelFriendRequest(accountKey))} aria-label={t('friends.cancelRequest')}>{t('friends.cancel')}</button>
        </>
      )}
      {relation === 'incoming' && (
        <>
          <button className={`button primary ${small}`} disabled={busy} onClick={run(() => acceptFriend(accountKey))} aria-label={t('friends.acceptRequest')}>{t('friends.accept')}</button>
          <button className={`button ${small}`} disabled={busy} onClick={run(() => ignoreFriend(accountKey))} aria-label={t('friends.ignoreRequest')}>{t('friends.ignore')}</button>
        </>
      )}
      {relation === 'friends' && !header && <span className="friend-chip on"><Users size={13} /> {t('friends.isFriend')}</span>}
      {error && <span className="error-text friend-error" role="alert">{error}</span>}
    </>
  )
}

/** A friend action in a DM: a small line ("Sam sent you a friend request"); quiet ones aren't shown. */
export function FriendLine({ dm, mine }: { dm: Dm; mine: boolean }) {
  const { t } = useTranslation()
  const action = dm.friend!
  const other = mine ? dm.to : dm.from
  const name = nameOf(other)
  const text = action.kind === 'request'
    ? (mine ? t('friends.line.requestMine', { name }) : t('friends.line.requestTheirs', { name }))
    : (mine ? t('friends.line.acceptMine', { name }) : t('friends.line.acceptTheirs', { name }))
  return (
    <div className="friend-line" role="note">
      <UserPlus size={14} />
      <span>{text}</span>
    </div>
  )
}

type Tab = 'online' | 'all' | 'pending'

const STATUS_ORDER = ['online', 'dnd', 'idle', 'offline'] as const

export function FriendsView({ onToggle }: { onToggle: (panel: Panel) => void }) {
  const { t } = useTranslation()
  const peers = useFriends((s) => s.peers)
  const unsent = useFriends((s) => s.unsent)
  const incoming = useIncomingCount()
  useApp((s) => s.servers) // presence and names
  const [tab, setTab] = useState<Tab>('all')
  const servers = useApp.getState().servers
  // Online first, then busy, away and offline; by name within each.
  const rank = (k: string) => STATUS_ORDER.indexOf(bestStatus(Object.values(servers).map((s) => statusOf(s.members[k]))))
  const byStatus = (a: [string, FriendPeer], b: [string, FriendPeer]) => rank(a[0]) - rank(b[0]) || nameOf(a[0]).localeCompare(nameOf(b[0]))
  const entries = Object.entries(peers).sort(byStatus)
  const friends = entries.filter(([, p]) => p.relation === 'friends')
  const online = friends.filter(([k]) => isOnline(k))
  const pendingIn = entries.filter(([, p]) => p.relation === 'incoming')
  const pendingOut = entries.filter(([, p]) => p.relation === 'outgoing')

  const tabButton = (id: Tab, label: string, badge = 0) => (
    <button role="tab" aria-selected={tab === id} className={`friends-tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
      {label}
      {badge > 0 && <span className="badge" aria-label={t('friends.pendingBadge', { count: badge })}>{badge}</span>}
    </button>
  )

  return (
    <div className="chat">
      <header className="chat-header friends-header">
        <button className="icon-button mobile-only" onClick={() => onToggle('nav')} aria-label={t('app.openMenu')}>
          <Menu />
        </button>
        <h1><span className="hash"><Users size={20} /></span>{t('friends.title')}</h1>
        <div className="friends-tabs" role="tablist" aria-label={t('friends.tabs.label')}>
          {tabButton('all', t('friends.tabs.all'))}
          {tabButton('online', t('friends.tabs.online'))}
          {tabButton('pending', t('friends.tabs.pending'), incoming)}
        </div>
      </header>
      <div className="friends" role="tabpanel">
        {tab === 'pending' ? (
          pendingIn.length + pendingOut.length === 0 ? (
            <Empty title={t('friends.empty.pending')} />
          ) : (
            <>
              {pendingIn.length > 0 && <h3 className="section-title">{t('friends.incomingCount', { count: pendingIn.length })}</h3>}
              {pendingIn.map(([k]) => <PersonRow key={k} accountKey={k} sub={t('friends.incoming')} />)}
              {pendingOut.length > 0 && <h3 className="section-title">{t('friends.outgoingCount', { count: pendingOut.length })}</h3>}
              {pendingOut.map(([k]) => <PersonRow key={k} accountKey={k} sub={unsent.includes(k) ? t('friends.notSentYet') : t('friends.outgoing')} />)}
            </>
          )
        ) : (tab === 'online' ? online : friends).length === 0 ? (
          tab === 'online' && friends.length > 0 ? <Empty title={t('friends.empty.online')} /> : <Empty title={t('friends.empty.all')} hint={t('friends.empty.allHint')} />
        ) : (
          <>
            <h3 className="section-title">{tab === 'online' ? t('friends.onlineCount', { count: online.length }) : t('friends.allCount', { count: friends.length })}</h3>
            {(tab === 'online' ? online : friends).map(([k]) => <PersonRow key={k} accountKey={k} />)}
          </>
        )}
      </div>
    </div>
  )
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Users size={32} /></span>
      <h1>{title}</h1>
      {hint && <p>{hint}</p>}
    </div>
  )
}

/** One person on the Friends page: right-click (or ⋯) for everything else. */
function PersonRow({ accountKey, sub }: { accountKey: string; sub?: string }) {
  const { t } = useTranslation()
  const relation = useRelation(accountKey)
  const name = nameOf(accountKey)
  const reachable = sharedServers(accountKey).length > 0
  const more = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    openUserMenu({ accountKey, serverKey: null, anchor: e.detail === 0 ? null : { x: r.left, y: r.bottom + 4 } })
  }
  return (
    <div className="friend-row" {...userMenuProps(accountKey)} data-account={accountKey}>
      <AccountAvatar name={name} accountKey={accountKey} size={40} />
      <div className="friend-text">
        <strong>{name}</strong>
        {sub ? <span className="muted">{sub}</span> : <AccountStatusText accountKey={accountKey} fallback className="muted" />}
      </div>
      {relation === 'friends' ? (
        <button className="button small" disabled={!reachable} title={reachable ? undefined : t('app.home.noSharedServer')} onClick={() => openConversation(accountKey)}>
          {t('friends.message')}
        </button>
      ) : (
        <FriendButtons accountKey={accountKey} header />
      )}
      <button className="icon-button small" onClick={more} aria-label={t('friends.more', { name })} title={t('friends.more', { name })}>
        <MoreDots />
      </button>
    </div>
  )
}
