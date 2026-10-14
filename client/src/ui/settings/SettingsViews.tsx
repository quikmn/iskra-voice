// The two settings places, each a full-window takeover: "My settings" (a neutral grey band with your avatar, only
// things about you) and one server's "server room" (a band in that server's colour with its tile, name and your
// role, only that server's config). Never both in one view. Close with Esc, ✕ or the browser/phone back button.
// Phones get a page stack: the band and the list first, then each section under a slim band ("Hangout › Roles").
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { b64u } from '../../core/crypto'
import { fingerprint } from '../../core/connection'
import { useApp, type ServerState } from '../../state/store'
import { useP2p } from '../../state/p2p'
import { useServerRoles } from '../../state/roles'
import { has } from '../../state/permissions'
import { useReports } from '../../state/reports'
import { Avatar } from '../bits'
import { ChevronLeft, ChevronRight, Close } from '../icons'
import { useEscapeLayer, useFocusTrap } from '../layers'
import { serverColor } from '../serverColor'
import { desktop } from '../../platform/desktop'
import { VoiceSettingsSection } from '../dialogs/VoiceSettings'
import { HotkeySettingsSection } from '../dialogs/HotkeySettings'
import { ClipSettingsSection } from '../clips/ClipSettings'
import { InputSettingsSection, OutputSettingsSection, ProcessingSettingsSection } from '../dialogs/AudioSettings'
import { DesktopSettingsSection } from '../dialogs/DesktopSettings'
import { RecoveryKeySection } from '../dialogs/RecoveryKey'
import { NotificationSettingsSection } from '../dialogs/NotificationSettings'
import { ProfileSection, ServerPagesOption } from '../profile/ProfileSettings'
import { AppearanceSection } from '../profile/AppearanceSettings'
import { InternetSection } from '../dialogs/InternetSettings'
import { EmojiSection, SoundboardSettingsSection, SoundsSection } from '../expressions/ExpressionSettings'
import { StickerSection } from '../chat/Stickers'
import { GifSettings, GifViewerSettings } from '../chat/GifSettings'
import { HiddenServersSection } from './HiddenServers'
import { DevicesSection } from '../dialogs/DevicesSection'
import { IntegrationsSection } from '../dialogs/Integrations'
import { BackupSection } from './BackupSection'
import { LimitsSection } from './LimitsSection'
import { BugInboxSection } from './BugInboxSection'
import { AfkSection } from '../afk/AfkSection'
import { UpdatesSection } from './UpdatesSection'
import { LanguageSection } from './LanguageSection'
import { RulesSection } from '../rules/Rules'
import { ImportSection } from './ImportSection'
import { AppLockSection, RotateKeySection } from '../keys/KeySettings'
import { KeyTransparencySection } from '../keys/KeyTransparency'
import { AuditLogSection, BlockedSection } from '../moderation/SafetySettings'
import { RolesSection } from '../roles/RoleSettings'
import { AutoModSection } from '../automod/AutoModSection'
import { AboutSection, AccountSection } from '../safety/AccountSection'
import { ReportsSection } from '../safety/ReportsSection'
import { PrivacySection } from './PrivacySection'
import { CameraSettingsSection } from '../media/CameraSettings'
import { CaptionSettingsSection } from '../media/CaptionSettings'
import { SecurityLogSection } from './SecurityLogSection'
import { MembersSection } from './MembersSection'
import { ServerTile } from './ServerTile'
import { ChannelsSection } from './ChannelsSection'
import { closeSettings, useSettingsView } from './open'
import { mySections, SERVER_GROUPS, serverSections, type MySectionId, type SectionInfo, type ServerSectionId } from './sections'
import './settings.css'
import './room.css'

const PHONE = '(max-width: 760px)'
const isPhone = () => window.matchMedia(PHONE).matches

function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhone)
  useEffect(() => {
    const query = window.matchMedia(PHONE)
    const onChange = () => setPhone(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return phone
}

/** Rendered once by the Shell. */
export function SettingsLayer() {
  const view = useSettingsView((s) => s.view)
  const opened = useSettingsView((s) => s.opened)
  if (!view) return null
  return view.kind === 'mine'
    ? <MySettings key={`mine:${opened}`} section={view.section} onClose={closeSettings} />
    : <ServerSettings key={`${view.serverKey}:${opened}`} serverKey={view.serverKey} section={view.section} onClose={closeSettings} />
}

const MARK = 'iskraSettings'

/**
 * The browser/phone back button: an entry in the history while the view is open. `onBack` returns true when the
 * view stays open (a phone section went back to the list), and the entry is put back. Closing any other way marks
 * the entry spent rather than going back (that would race a view opened right after); the next view reuses it.
 */
function useBackButton(onBack: () => boolean) {
  const latest = useRef(onBack)
  useEffect(() => {
    latest.current = onBack
  })
  useEffect(() => {
    const live = { [MARK]: 'open' }
    if ((history.state as Record<string, unknown> | null)?.[MARK] === 'spent') history.replaceState(live, '')
    else history.pushState(live, '')
    const onPop = () => {
      if (latest.current()) history.pushState(live, '')
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if ((history.state as Record<string, unknown> | null)?.[MARK] === 'open') history.replaceState({ [MARK]: 'spent' }, '')
    }
  }, [])
}

/** The window title names what's open, while it's open. */
function useTitle(title: string) {
  useEffect(() => {
    const before = document.title
    document.title = title
    return () => {
      document.title = before
    }
  }, [title])
}

interface NavGroup<Id extends string> {
  id: string
  title: string | null
  items: (SectionInfo & { id: Id; count?: number })[]
}

/** The shared frame: a band, then the grouped nav beside the section (wide) or a page stack (phones). */
function Takeover<Id extends string>({ kind, label, style, band, crumb, groups, initial, onClose, render }: {
  kind: 'mine' | 'server'
  label: string
  style?: CSSProperties
  band: ReactNode
  /** The small picture and name for a phone section page's slim band. */
  crumb: { icon: ReactNode; name: string }
  groups: NavGroup<Id>[]
  initial?: Id
  onClose: () => void
  render: (id: Id) => ReactNode
}) {
  const { t } = useTranslation()
  const phone = usePhone()
  const ref = useRef<HTMLDivElement>(null)
  const all = groups.flatMap((g) => g.items)
  const [picked, setPicked] = useState<Id | null>(initial && all.some((s) => s.id === initial) ? initial : isPhone() ? null : all[0]?.id ?? null)
  // A section can vanish (rights changed); wide screens always show one.
  const current = all.find((s) => s.id === picked) ?? (phone ? null : all[0] ?? null)
  useEscapeLayer(onClose)
  useFocusTrap(ref)
  useBackButton(() => {
    if (phone && current) {
      setPicked(null)
      return true
    }
    onClose()
    return false
  })

  const closeButton = (
    <button className="icon-button room-close" onClick={onClose} aria-label={t('common.close')} title={t('settings.room.closeHint')}>
      <Close />
    </button>
  )
  const nav = (
    <nav className="settings-nav" aria-label={t('settings.dialog.sectionsLabel')}>
      {groups.map((group) => group.items.length > 0 && (
        <div key={group.id} className="settings-nav-group">
          {group.title && <div className="settings-nav-title">{group.title}</div>}
          {group.items.map((s) => (
            <button
              key={s.id}
              className={`settings-nav-item ${current?.id === s.id ? 'active' : ''}`}
              aria-current={current?.id === s.id ? 'page' : undefined}
              onClick={() => setPicked(s.id)}
            >
              <span>{s.label}</span>
              {!!s.count && <span className="settings-nav-count" aria-label={t('settings.room.count', { n: s.count })}>{s.count}</span>}
              {phone && <ChevronRight size={16} />}
            </button>
          ))}
        </div>
      ))}
    </nav>
  )

  return (
    <div className={`settings-room room-${kind} ${phone ? (current ? 'phone-pane' : 'phone-list') : ''}`} style={style}
      role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
      {phone && current ? (
        <header className="room-slim">
          <button className="icon-button" onClick={() => setPicked(null)} aria-label={t('common.back')}><ChevronLeft /></button>
          {crumb.icon}
          <h2 className="room-crumb">
            <span className="room-crumb-name">{crumb.name}</span>
            <span className="room-crumb-sep" aria-hidden>›</span>
            <span>{current.label}</span>
          </h2>
          {closeButton}
        </header>
      ) : (
        <header className="room-band">
          {band}
          {!phone && <kbd className="room-esc" aria-hidden>Esc</kbd>}
          {closeButton}
        </header>
      )}
      <div className="room-body">
        {(!phone || !current) && nav}
        {current && (
          <div className="settings-pane" key={current.id}>
            {render(current.id)}
          </div>
        )}
      </div>
    </div>
  )
}

// ── My settings ────────────────────────────────────────────────────────────

export function MySettings({ section, onClose }: { section?: MySectionId; onClose: () => void }) {
  const { t } = useTranslation()
  const profile = useApp((s) => s.profile)
  const identity = useApp((s) => s.identity)
  const name = profile?.name ?? ''
  const accountKey = identity ? b64u(identity.account.publicKey) : ''
  useTitle(`${t('settings.room.mine')} — Iskra`)
  return (
    <Takeover<MySectionId>
      kind="mine"
      label={t('common.settings')}
      band={
        <div className="room-identity">
          {accountKey && <Avatar name={name} accountKey={accountKey} size={56} />}
          <div className="room-titles">
            <h1 className="room-name">{t('settings.room.mine')}</h1>
            <p className="room-sub">{name}</p>
          </div>
        </div>
      }
      crumb={{ icon: accountKey ? <Avatar name={name} accountKey={accountKey} size={24} /> : null, name: t('settings.room.mine') }}
      groups={[{ id: 'mine', title: null, items: mySections(!!desktop) }]}
      initial={section}
      onClose={onClose}
      render={(id) => <MySection id={id} />}
    />
  )
}

function MySection({ id }: { id: MySectionId }) {
  switch (id) {
    case 'profile': return <ProfileSection />
    case 'appearance': return <><AppearanceSection /><HiddenServersSection /></>
    case 'language': return <LanguageSection />
    case 'devices': return <DevicesSection />
    // Everything about your account key together: the recovery key, rotating the key, and checking the key logs.
    case 'recovery': return <><RecoveryKeySection /><RotateKeySection /><KeyTransparencySection /></>
    case 'security': return <AppLockSection />
    case 'notifications': return <NotificationSettingsSection server={null} />
    case 'voice': return <><InputSettingsSection /><VoiceSettingsSection /><HotkeySettingsSection /><ClipSettingsSection /><ProcessingSettingsSection /><OutputSettingsSection /><CaptionSettingsSection /><SoundboardSettingsSection /></>
    case 'video': return <CameraSettingsSection />
    case 'blocked': return <BlockedSection />
    case 'desktop': return <DesktopSettingsSection />
    case 'account': return <AccountSection />
    case 'privacy': return <><PrivacySection /><GifViewerSettings /></>
    case 'about': return <AboutSection />
  }
}

// ── Server settings (the server room) ──────────────────────────────────────

export function ServerSettings({ serverKey, section, onClose }: { serverKey: string; section?: ServerSectionId; onClose: () => void }) {
  const { t } = useTranslation()
  const server = useApp((s) => s.servers[serverKey])
  const roles = useServerRoles(serverKey)
  const reports = useReports((s) => s.open[serverKey] ?? 0)
  const me = server?.me
  const sections = serverSections(me?.role, (perm) => has(me, roles, perm))
  const gone = !server || sections.length === 0
  // Pinned to this server: if it goes away (left, removed, rights taken), the room closes.
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])
  useTitle(server ? `${t('settings.room.title', { name: server.name })} — Iskra` : 'Iskra')
  if (gone) return null
  const colors = serverColor(server.key)
  const groups: NavGroup<ServerSectionId>[] = SERVER_GROUPS.map((group) => ({
    id: group,
    title: t(`settings.room.groups.${group}`),
    items: sections.filter((s) => s.group === group).map((s) => (s.id === 'reports' ? { ...s, count: reports } : s)),
  }))
  return (
    <Takeover<ServerSectionId>
      kind="server"
      label={t('settings.room.title', { name: server.name })}
      style={{ ['--room-band' as string]: colors.band, ['--room-marker' as string]: colors.marker }}
      band={
        <div className="room-identity">
          <ServerTile server={server} />
          <div className="room-titles">
            <h1 className="room-name">{server.name}</h1>
            <p className="room-sub">{t('settings.room.subtitle', { role: t(`common.roles.${me!.role}`) })}</p>
          </div>
        </div>
      }
      crumb={{ icon: <ServerTile server={server} size="small" />, name: server.name }}
      groups={groups}
      initial={section}
      onClose={onClose}
      render={(id) => <ServerSection id={id} server={server} onClose={onClose} />}
    />
  )
}

function ServerSection({ id, server, onClose }: { id: ServerSectionId; server: ServerState; onClose: () => void }) {
  switch (id) {
    case 'overview': return <OverviewSection server={server} />
    case 'channels': return <ChannelsSection server={server} />
    case 'emoji': return <><EmojiSection server={server} /><StickerSection server={server} /></>
    case 'gifs': return <GifsSection server={server} />
    case 'sounds': return <SoundsSection server={server} />
    case 'pages': return <PagesSection server={server} />
    case 'rules': return <RulesSection server={server} />
    case 'serverVoice': return <AfkSection server={server} />
    case 'members': return <MembersSection server={server} />
    case 'roles': return <RolesSection server={server} />
    case 'reports': return <ReportsSection server={server} onClose={onClose} />
    case 'automod': return <AutoModSection server={server} />
    case 'audit': return <AuditLogSection server={server} />
    case 'securityLog': return <SecurityLogSection server={server} />
    case 'integrations': return <IntegrationsSection server={server} />
    case 'internet': return <InternetSection server={server} />
    case 'limits': return <LimitsSection server={server} />
    case 'bugInbox': return <BugInboxSection server={server} />
    case 'backup': return <BackupSection server={server} />
    case 'import': return <ImportSection server={server} />
    case 'updates': return <UpdatesSection server={server} />
  }
}

function OverviewSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const tunnel = useP2p((s) => s.via[server.key])
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.overview')}</h2>
      <dl className="settings-facts">
        <div><dt>{t('settings.overview.name')}</dt><dd>{server.name}</dd></div>
        <div><dt>{t('settings.overview.yourRole')}</dt><dd className="capitalize">{server.me?.role ? t(`common.roles.${server.me.role}`) : t('settings.overview.notJoined')}</dd></div>
        <div><dt>{t('settings.overview.address')}</dt><dd><code>{server.directUrl}</code></dd></div>
        {tunnel && <div data-testid="overview-p2p"><dt>{t('settings.overview.connection')}</dt><dd>{t('hosting.p2p.via')}</dd></div>}
        <div><dt>{t('settings.overview.serverId')}</dt><dd><code>{fingerprint(server.key)}</code></dd></div>
      </dl>
    </section>
  )
}

function GifsSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.gifs')}</h2>
      <GifSettings server={server} heading={false} />
    </section>
  )
}

function PagesSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.pages')}</h2>
      <p className="muted">{t('settings.pages.intro')}</p>
      <ServerPagesOption server={server} />
    </section>
  )
}
