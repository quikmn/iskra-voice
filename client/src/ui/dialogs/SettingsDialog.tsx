import { useState } from 'react'
import { fingerprint } from '../../core/connection'
import { leaveServer, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { VoiceSettingsSection } from './VoiceSettings'
import { RecoveryKeySection } from './RecoveryKey'
import { NotificationSettingsSection } from './NotificationSettings'
import { ProfileSection, ServerPagesOption } from '../profile/ProfileSettings'
import { AppearanceSection } from '../profile/AppearanceSettings'
import { ServerExpressionsSections, SoundboardSettingsSection } from '../expressions/ExpressionSettings'

export function SettingsDialog({ server, onClose }: { server?: ServerState | null; onClose: () => void }) {
  const [confirmLeave, setConfirmLeave] = useState(false)

  return (
    <Modal title="Settings" onClose={onClose}>
      <ProfileSection />

      <AppearanceSection />

      <RecoveryKeySection />

      <VoiceSettingsSection />

      <SoundboardSettingsSection />

      <NotificationSettingsSection />

      {server && <ServerExpressionsSections server={server} />}

      {server && <section className="settings-section">
        <h3>This server</h3>
        <p className="muted">
          {server.name} · <code>{fingerprint(server.key)}</code>
        </p>
        <ServerPagesOption server={server} />
        {confirmLeave ? (
          <div className="copy-row">
            <span>Remove this server from your list?</span>
            <button className="button danger" onClick={() => { leaveServer(server.key); onClose() }}>Remove</button>
            <button className="button" onClick={() => setConfirmLeave(false)}>Cancel</button>
          </div>
        ) : (
          <button className="button danger-outline" onClick={() => setConfirmLeave(true)}>Remove server from my list</button>
        )}
      </section>}
    </Modal>
  )
}
