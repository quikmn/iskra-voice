// Settings: a sidebar of sections on wide screens, a list that opens each section on phones.
// "My account" is about you on every server; "This server" is the server you're looking at, by role.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fingerprint } from '../../core/connection'
import { leaveServer, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { VoiceSettingsSection } from '../dialogs/VoiceSettings'
import { HotkeySettingsSection } from '../dialogs/HotkeySettings'
import { InputSettingsSection, OutputSettingsSection, ProcessingSettingsSection } from '../dialogs/AudioSettings'
import { DesktopSettingsSection } from '../dialogs/DesktopSettings'
import { desktop } from '../../platform/desktop'
import { RecoveryKeySection } from '../dialogs/RecoveryKey'
import { NotificationSettingsSection } from '../dialogs/NotificationSettings'
import { ProfileSection, ServerPagesOption } from '../profile/ProfileSettings'
import { AppearanceSection } from '../profile/AppearanceSettings'
import { InternetSection } from '../dialogs/InternetSettings'
import { EmojiSection, SoundboardSettingsSection, SoundsSection } from '../expressions/ExpressionSettings'
import { StickerSection } from '../chat/Stickers'
import { GifSettings, GifViewerSettings } from '../chat/GifSettings'
import { DevicesSection } from '../dialogs/DevicesSection'
import { IntegrationsSection } from '../dialogs/Integrations'
import { BackupSection } from './BackupSection'
import { LimitsSection } from './LimitsSection'
import { UpdatesSection } from './UpdatesSection'
import { LanguageSection } from './LanguageSection'
import { RulesSection } from '../rules/Rules'
import { ImportSection } from './ImportSection'
import { AppLockSection, RotateKeySection } from '../keys/KeySettings'
import { ChevronRight } from '../icons'
import { AuditLogSection, BlockedSection } from '../moderation/SafetySettings'
import { NicknameField } from '../organize/ServerSettings'
import { RolesSection } from '../roles/RoleSettings'
import { AutoModSection } from '../automod/AutoModSection'
import { useServerRoles } from '../../state/roles'
import { has } from '../../state/permissions'
import { settingsSections, type SectionId } from './sections'
import { AboutSection, AccountSection } from '../safety/AccountSection'
import { ReportsSection } from '../safety/ReportsSection'
import { PrivacySection } from './PrivacySection'
import { SecurityLogSection } from './SecurityLogSection'
import './settings.css'

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

export function SettingsDialog({ server, onClose, section: initial }: { server?: ServerState | null; onClose: () => void; section?: SectionId }) {
  const { t } = useTranslation()
  const phone = usePhone()
  const roles = useServerRoles(server?.key)
  const sections = settingsSections(server?.me?.role, (perm) => has(server?.me, roles, perm), !!desktop)
  const [picked, setPicked] = useState<SectionId | null>(initial ?? (isPhone() ? null : 'profile'))
  // A section can vanish (role changed); wide screens always show one.
  const current = sections.find((s) => s.id === picked) ?? (phone ? null : sections[0])
  const showList = !phone || !current
  const showPane = !!current

  return (
    <Modal
      title={t('common.settings')}
      heading={phone && current ? current.label : t('common.settings')}
      onBack={phone && current ? () => setPicked(null) : undefined}
      onClose={onClose}
      className="settings-modal"
    >
      <div className={`settings-layout ${phone ? (current ? 'phone-pane' : 'phone-list') : ''}`}>
        {showList && (
          <nav className="settings-nav" aria-label={t('settings.dialog.sectionsLabel')}>
            {(['account', 'server'] as const).map((group) => {
              const items = sections.filter((s) => s.group === group)
              if (items.length === 0) return null
              return (
                <div key={group} className="settings-nav-group">
                  <div className="settings-nav-title" title={group === 'server' ? server?.name : undefined}>
                    {group === 'account' ? t('settings.dialog.myAccount') : t('settings.dialog.thisServer', { name: server?.name ?? '' })}
                  </div>
                  {items.map((s) => (
                    <button
                      key={s.id}
                      className={`settings-nav-item ${current?.id === s.id ? 'active' : ''}`}
                      aria-current={current?.id === s.id ? 'page' : undefined}
                      onClick={() => setPicked(s.id)}
                    >
                      <span>{s.label}</span>
                      {phone && <ChevronRight size={16} />}
                    </button>
                  ))}
                </div>
              )
            })}
          </nav>
        )}
        {showPane && (
          <div className="settings-pane" key={current.id}>
            <Section id={current.id} server={server ?? null} onClose={onClose} />
          </div>
        )}
      </div>
    </Modal>
  )
}

function Section({ id, server, onClose }: { id: SectionId; server: ServerState | null; onClose: () => void }) {
  switch (id) {
    case 'profile': return <ProfileSection />
    case 'appearance': return <><AppearanceSection /><LanguageSection /><GifViewerSettings /></>
    case 'devices': return <DevicesSection />
    case 'recovery': return <><RecoveryKeySection /><RotateKeySection /></>
    case 'security': return <AppLockSection />
    case 'notifications': return <NotificationSettingsSection server={server} />
    case 'voice': return <><InputSettingsSection /><VoiceSettingsSection /><HotkeySettingsSection /><ProcessingSettingsSection /><OutputSettingsSection /><SoundboardSettingsSection /></>
    case 'blocked': return <BlockedSection />
    case 'desktop': return <DesktopSettingsSection />
    case 'account': return <AccountSection />
    case 'privacy': return <PrivacySection />
    case 'about': return <AboutSection />
  }
  if (!server) return null
  switch (id) {
    case 'overview': return <OverviewSection server={server} onClose={onClose} />
    case 'emoji': return <><EmojiSection server={server} /><StickerSection server={server} /></>
    case 'sounds': return <SoundsSection server={server} />
    case 'integrations': return <IntegrationsSection server={server} />
    case 'pages': return <PagesSection server={server} />
    case 'internet': return <InternetSection server={server} />
    case 'audit': return <AuditLogSection server={server} />
    case 'reports': return <ReportsSection server={server} onClose={onClose} />
    case 'limits': return <LimitsSection server={server} />
    case 'rules': return <RulesSection server={server} />
    case 'backup': return <BackupSection server={server} />
    case 'import': return <ImportSection server={server} />
    case 'updates': return <UpdatesSection server={server} />
    case 'roles': return <RolesSection server={server} />
    case 'automod': return <AutoModSection server={server} />
    case 'securityLog': return <SecurityLogSection server={server} />
  }
}

function OverviewSection({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const { t } = useTranslation()
  const [confirmLeave, setConfirmLeave] = useState(false)
  return (
    <section className="settings-section">
      <h3>{t('settings.sections.overview')}</h3>
      <dl className="settings-facts">
        <div><dt>{t('settings.overview.name')}</dt><dd>{server.name}</dd></div>
        <div><dt>{t('settings.overview.yourRole')}</dt><dd className="capitalize">{server.me?.role ? t(`common.roles.${server.me.role}`) : t('settings.overview.notJoined')}</dd></div>
        <div><dt>{t('settings.overview.address')}</dt><dd><code>{server.url}</code></dd></div>
        <div><dt>{t('settings.overview.serverId')}</dt><dd><code>{fingerprint(server.key)}</code></dd></div>
      </dl>
      {server.me && <NicknameField server={server} member={server.me} />}
      <GifSettings server={server} />
      <div className="settings-danger">
        <div>
          <strong>{t('settings.overview.removeTitle')}</strong>
          <p className="muted">{t('settings.overview.removeHint')}</p>
        </div>
        {confirmLeave ? (
          <div className="copy-row">
            <button className="button danger" onClick={() => { leaveServer(server.key); onClose() }}>{t('common.remove')}</button>
            <button className="button" onClick={() => setConfirmLeave(false)}>{t('common.cancel')}</button>
          </div>
        ) : (
          <button className="button danger-outline" onClick={() => setConfirmLeave(true)}>{t('settings.overview.removeServer')}</button>
        )}
      </div>
    </section>
  )
}

function PagesSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  return (
    <section className="settings-section">
      <h3>{t('settings.sections.pages')}</h3>
      <p className="muted">{t('settings.pages.intro')}</p>
      <ServerPagesOption server={server} />
    </section>
  )
}
