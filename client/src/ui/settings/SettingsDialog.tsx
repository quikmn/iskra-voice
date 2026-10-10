// Settings: a sidebar of sections on wide screens, a list that opens each section on phones.
// "My account" is about you on every server; "This server" is the server you're looking at, by role.
import { useEffect, useState } from 'react'
import { fingerprint } from '../../core/connection'
import { leaveServer, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { VoiceSettingsSection } from '../dialogs/VoiceSettings'
import { RecoveryKeySection } from '../dialogs/RecoveryKey'
import { NotificationSettingsSection } from '../dialogs/NotificationSettings'
import { ProfileSection, ServerPagesOption } from '../profile/ProfileSettings'
import { AppearanceSection } from '../profile/AppearanceSettings'
import { InternetSection } from '../dialogs/InternetSettings'
import { EmojiSection, SoundboardSettingsSection, SoundsSection } from '../expressions/ExpressionSettings'
import { DevicesSection } from '../dialogs/DevicesSection'
import { IntegrationsSection } from '../dialogs/Integrations'
import { AppLockSection, RotateKeySection } from '../keys/KeySettings'
import { ChevronRight } from '../icons'
import { settingsSections, type SectionId } from './sections'
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
  const phone = usePhone()
  const sections = settingsSections(server?.me?.role)
  const [picked, setPicked] = useState<SectionId | null>(initial ?? (isPhone() ? null : 'profile'))
  // A section can vanish (role changed); wide screens always show one.
  const current = sections.find((s) => s.id === picked) ?? (phone ? null : sections[0])
  const showList = !phone || !current
  const showPane = !!current

  return (
    <Modal
      title="Settings"
      heading={phone && current ? current.label : 'Settings'}
      onBack={phone && current ? () => setPicked(null) : undefined}
      onClose={onClose}
      className="settings-modal"
    >
      <div className={`settings-layout ${phone ? (current ? 'phone-pane' : 'phone-list') : ''}`}>
        {showList && (
          <nav className="settings-nav" aria-label="Settings sections">
            {(['account', 'server'] as const).map((group) => {
              const items = sections.filter((s) => s.group === group)
              if (items.length === 0) return null
              return (
                <div key={group} className="settings-nav-group">
                  <div className="settings-nav-title" title={group === 'server' ? server?.name : undefined}>
                    {group === 'account' ? 'My account' : `This server · ${server?.name ?? ''}`}
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
    case 'appearance': return <AppearanceSection />
    case 'devices': return <DevicesSection />
    case 'recovery': return <><RecoveryKeySection /><RotateKeySection /></>
    case 'security': return <AppLockSection />
    case 'notifications': return <NotificationSettingsSection />
    case 'voice': return <><VoiceSettingsSection /><SoundboardSettingsSection /></>
  }
  if (!server) return null
  switch (id) {
    case 'overview': return <OverviewSection server={server} onClose={onClose} />
    case 'emoji': return <EmojiSection server={server} />
    case 'sounds': return <SoundsSection server={server} />
    case 'integrations': return <IntegrationsSection server={server} />
    case 'pages': return <PagesSection server={server} />
    case 'internet': return <InternetSection server={server} />
  }
}

function OverviewSection({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const [confirmLeave, setConfirmLeave] = useState(false)
  return (
    <section className="settings-section">
      <h3>Overview</h3>
      <dl className="settings-facts">
        <div><dt>Name</dt><dd>{server.name}</dd></div>
        <div><dt>Your role</dt><dd className="capitalize">{server.me?.role ?? 'not joined'}</dd></div>
        <div><dt>Address</dt><dd><code>{server.url}</code></dd></div>
        <div><dt>Server ID</dt><dd><code>{fingerprint(server.key)}</code></dd></div>
      </dl>
      <div className="settings-danger">
        <div>
          <strong>Remove from my list</strong>
          <p className="muted">Hides this server here. You stay a member and can come back with any invite link.</p>
        </div>
        {confirmLeave ? (
          <div className="copy-row">
            <button className="button danger" onClick={() => { leaveServer(server.key); onClose() }}>Remove</button>
            <button className="button" onClick={() => setConfirmLeave(false)}>Cancel</button>
          </div>
        ) : (
          <button className="button danger-outline" onClick={() => setConfirmLeave(true)}>Remove server</button>
        )}
      </div>
    </section>
  )
}

function PagesSection({ server }: { server: ServerState }) {
  return (
    <section className="settings-section">
      <h3>Profile pages</h3>
      <p className="muted">
        Members can make a small web page that opens from their profile card. Pages run in a sandbox: they can't see anyone's account or
        messages, and their scripts only run when the viewer allows it. Admins can remove any page.
      </p>
      <ServerPagesOption server={server} />
    </section>
  )
}
