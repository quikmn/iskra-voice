// Profile cards (a popover on wide screens, a bottom sheet on phones), the profile page viewer,
// and the full member dialog they lead to. Rendered once by the Shell.
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { fingerprint } from '../../core/connection'
import { pageUrl, wrapperDocument } from '../../core/profile'
import { roleRank, type Member } from '../../core/protocol'
import { openConversation } from '../../state/dms'
import { FriendButtons } from '../people/Friends'
import {
  closeMemberDetails, closeProfileCard, closeProfilePage, openMemberDetails, openProfilePage, removeMemberPage, useProfiles,
} from '../../state/profile'
import { useApp, type ServerState } from '../../state/store'
import { Avatar, Modal } from '../bits'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { MemberDialog } from '../dialogs/MemberDialog'
import { RoleChips } from '../roles/RoleSettings'
import { openMySettings } from '../settings/open'
import { hueFor } from '../format'
import { Close } from '../icons'
import { renderMarkdown } from '../markdown'
import { EmailSafe, Secret } from '../streamer/StreamerBits'
import { useMemberPresence } from '../../state/presence'
import { STATUS_LABELS } from '../../state/presenceRules'
import { CustomStatusLine } from '../presence/Presence'
import { ActivityLine } from '../ActivityLine'
import { PageWebview, pageWall, useLoading } from './PageView'
import './profile.css'

export function ProfileLayer() {
  const card = useProfiles((s) => s.card)
  const viewer = useProfiles((s) => s.viewer)
  const details = useProfiles((s) => s.details)
  const cardServer = useApp((s) => (card ? s.servers[card.serverKey] : undefined))
  const viewerServer = useApp((s) => (viewer ? s.servers[viewer.serverKey] : undefined))
  const detailsServer = useApp((s) => (details ? s.servers[details.serverKey] : undefined))

  const cardMember = card && cardServer?.members[card.accountKey]
  const viewerMember = viewer && viewerServer?.members[viewer.accountKey]
  const detailsMember = details && detailsServer?.members[details.accountKey]

  return (
    <>
      {card && cardServer && cardMember && (
        <ProfileCard
          server={cardServer}
          member={cardMember}
          rect={card.rect}
          onEdit={() => {
            closeProfileCard()
            openMySettings('profile')
          }}
        />
      )}
      {viewer && viewerServer && viewerMember && <PageViewer server={viewerServer} member={viewerMember} />}
      {details && detailsServer && detailsMember && <MemberDialog server={detailsServer} member={detailsMember} onClose={closeMemberDetails} />}
    </>
  )
}

const CARD_WIDTH = 320
const GAP = 8

/** Where a popover of this size goes next to `rect`: right of it (else left), top-aligned, shifted to fit the window. */
export function cardPosition(rect: { top: number; left: number; right: number }, width: number, height: number, vw: number, vh: number) {
  const fitsRight = rect.right + GAP + width <= vw - GAP
  const left = fitsRight ? rect.right + GAP : Math.max(GAP, rect.left - GAP - width)
  const top = Math.max(GAP, Math.min(rect.top, vh - height - GAP))
  return { left: Math.min(left, Math.max(GAP, vw - width - GAP)), top }
}

const narrow = () => window.matchMedia('(max-width: 760px)').matches

function ProfileCard({ server, member, rect, onEdit }: { server: ServerState; member: Member; rect: DOMRect | null; onEdit: () => void }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const sheet = !rect || narrow()
  const pagesOn = useProfiles((s) => !!s.pagesEnabled[server.key])
  const me = server.me
  const isSelf = me?.accountKey === member.accountKey
  const page = pagesOn ? pageUrl(server.url, member.page) : null
  const presence = useMemberPresence(member)

  // Next to what was clicked, kept inside the window: re-placed whenever the card's size or the window changes
  // (a friend request or late content can make it grow while open).
  useLayoutEffect(() => {
    const el = ref.current
    if (sheet || !rect || !el) return
    const place = () => setPosition(cardPosition(rect, el.offsetWidth || CARD_WIDTH, el.offsetHeight, window.innerWidth, window.innerHeight))
    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(el)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [rect, sheet])

  useEscapeLayer(closeProfileCard)
  useFocusTrap(ref)

  const banner = member.accent ?? `hsl(${hueFor(member.accountKey)} 45% 32%)`
  return (
    <div className={`profile-card-backdrop ${sheet ? 'sheet' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && closeProfileCard()}>
      <div
        ref={ref}
        className="profile-card"
        role="dialog"
        aria-label={t('profile.cardLabel', { name: member.name })}
        tabIndex={-1}
        style={sheet ? undefined : { width: CARD_WIDTH, left: position?.left ?? -9999, top: position?.top ?? 0 }}
      >
        <div className="profile-scroll">
          <div className="profile-banner" style={{ background: banner }}>
            <button className="icon-button small profile-close" onClick={closeProfileCard} aria-label={t('common.close')}>
              <Close />
            </button>
          </div>
          <div className="profile-head">
            <span className="profile-avatar-ring" style={{ background: 'var(--float)' }}>
              <Avatar name={member.name} accountKey={member.accountKey} size={80} status={presence.status} />
            </span>
          </div>
          <div className="profile-body">
            <h2 className="profile-name">{member.name}</h2>
            {member.nick && member.profileName && member.profileName !== member.name && <div className="profile-realname">{t('profile.nameLine', { name: member.profileName })}</div>}
            <div className="profile-sub">
              {member.pronouns && <span>{member.pronouns}</span>}
              <span className={`role-chip role-${member.role}`}>{t(`common.roles.${member.role}`)}</span>
              <span className="profile-status-label"><span className={`status-dot presence-${presence.status}`} aria-hidden />{STATUS_LABELS[presence.status]}</span>
            </div>
            {presence.custom && <div className="profile-status"><CustomStatusLine custom={presence.custom} /></div>}
            <RoleChips server={server} member={member} />
            {member.activity && <div className="profile-activity"><ActivityLine activity={member.activity} /></div>}
            {member.bio && (
              <div className="profile-bio">
                <EmailSafe text={member.bio} render={(bio) => renderMarkdown(bio, { nameOf: (k) => server.members[k]?.name ?? null, me: me?.accountKey })} />
              </div>
            )}
            <div className="profile-id muted">{t('settings.member.id')} <code><Secret value={fingerprint(member.accountKey)} /></code></div>
          </div>
        </div>
        {/* Outside the scrolling part, so the buttons are always in sight. */}
        <div className="profile-actions">
          {page && (
            <button className="button primary" onClick={() => openProfilePage(server.key, member.accountKey)}>
              {t('profile.openPage')}
            </button>
          )}
          {!isSelf && !member.builtin && (
            <button className="button" onClick={() => { openConversation(member.accountKey); closeProfileCard() }}>{t('settings.member.message')}</button>
          )}
          {!isSelf && <FriendButtons accountKey={member.accountKey} />}
          {isSelf ? (
            <button className="button" onClick={onEdit}>{t('profile.edit')}</button>
          ) : (
            <button className="button" onClick={() => openMemberDetails(server.key, member.accountKey)}>{t('common.more')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A member's page. In the desktop app it runs with scripts behind the app's wall; elsewhere it's static HTML and CSS
 * in a sandbox inside a wrapper that pins where it can go (an author's own page keeps its scripts, as in the editor).
 */
export function PageViewer({ server, member }: { server: ServerState; member: Member }) {
  const { t } = useTranslation()
  const url = pageUrl(server.url, member.page)
  const me = server.me
  const canRemove = !!me && me.accountKey !== member.accountKey && roleRank(me.role) >= roleRank('admin') && roleRank(me.role) > roleRank(member.role)
  const [error, setError] = useState<string | null>(null)
  const isSelf = me?.accountKey === member.accountKey
  const wall = pageWall()
  const title = t('profile.frameTitle', { name: member.name })
  const [loading, loaded] = useLoading(url ?? '')

  return (
    <Modal title={t('profile.viewerTitle', { name: member.name })} onClose={closeProfilePage} wide>
      <p className="page-note muted">
        {t('profile.madeBy', { name: member.name })}
        {url && !wall && !isSelf && ` ${t('profile.scriptsDesktop')}`}
      </p>
      {url && wall ? (
        <PageWebview className="page-frame" src={`${url}?scripts=1`} title={title} />
      ) : url ? (
        <iframe key={url} className={`page-frame ${loading}`} title={title} srcDoc={wrapperDocument(url, isSelf)} referrerPolicy="no-referrer" onLoad={loaded} />
      ) : (
        <p className="muted">{t('profile.unavailable')}</p>
      )}
      {canRemove && (
        <div className="copy-row page-admin">
          <button
            className="button danger-outline small"
            onClick={() =>
              void removeMemberPage(server.key, member).then(closeProfilePage, (e: Error) => setError(errorMessage(e)))
            }
          >
            {t('profile.removePage')}
          </button>
          {error && <span className="error-text">{error}</span>}
        </div>
      )}
    </Modal>
  )
}
