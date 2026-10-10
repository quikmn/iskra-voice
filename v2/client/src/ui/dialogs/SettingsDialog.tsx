import { useState } from 'react'
import { b64u } from '../../core/crypto'
import { fingerprint } from '../../core/connection'
import { leaveServer, renameMe, useApp, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { VoiceSettingsSection } from './VoiceSettings'
import { RecoveryKeySection } from './RecoveryKey'
import { NotificationSettingsSection } from './NotificationSettings'

export function SettingsDialog({ server, onClose }: { server: ServerState; onClose: () => void }) {
  const profile = useApp((s) => s.profile)
  const identity = useApp((s) => s.identity)
  const [name, setName] = useState(profile?.name ?? '')
  const [saved, setSaved] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const trimmed = name.trim()

  async function save() {
    if (!trimmed || trimmed === profile?.name) return
    await renameMe(trimmed)
    setSaved(true)
  }

  return (
    <Modal title="Settings" onClose={onClose}>
      <section className="settings-section">
        <h3>Profile</h3>
        <label className="field">
          <span>Display name</span>
          <div className="copy-row">
            <input value={name} maxLength={32} onChange={(e) => { setName(e.target.value); setSaved(false) }} onKeyDown={(e) => e.key === 'Enter' && void save()} />
            <button className="button primary" disabled={!trimmed || trimmed === profile?.name} onClick={() => void save()}>
              {saved ? 'Saved' : 'Save'}
            </button>
          </div>
        </label>
        {identity && (
          <p className="muted">
            Your ID: <code>{fingerprint(b64u(identity.account.publicKey))}</code>. Friends can use it to check it's really you.
          </p>
        )}
      </section>

      <RecoveryKeySection />

      <VoiceSettingsSection />

      <NotificationSettingsSection />

      <section className="settings-section">
        <h3>This server</h3>
        <p className="muted">
          {server.name} · <code>{fingerprint(server.key)}</code>
        </p>
        {confirmLeave ? (
          <div className="copy-row">
            <span>Remove this server from your list?</span>
            <button className="button danger" onClick={() => { leaveServer(server.key); onClose() }}>Remove</button>
            <button className="button" onClick={() => setConfirmLeave(false)}>Cancel</button>
          </div>
        ) : (
          <button className="button danger-outline" onClick={() => setConfirmLeave(true)}>Remove server from my list</button>
        )}
      </section>
    </Modal>
  )
}
