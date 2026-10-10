import { useState } from 'react'
import { fingerprint } from '../../core/connection'
import { ROLES, roleRank, type Member, type Role } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { setVolume, useVoice } from '../../state/voice'
import { Avatar, Modal } from '../bits'

export function MemberDialog({ server, member, onClose }: { server: ServerState; member: Member; onClose: () => void }) {
  const me = server.me
  const isSelf = me?.accountKey === member.accountKey
  const canModerate = !!me && !isSelf && roleRank(me.role) >= roleRank('admin') && roleRank(me.role) > roleRank(member.role)
  const grantable = me ? ROLES.filter((r) => roleRank(r) < roleRank(me.role)) : []
  const [confirm, setConfirm] = useState<'kick' | 'ban' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const connection = connectionFor(server.key)
  const voiceSession = useVoice((s) => s.session)
  const volume = useVoice((s) => s.volumes[member.accountKey] ?? 1)
  const inMyVoice = !isSelf && voiceSession?.serverKey === server.key &&
    (server.voice[voiceSession.channelId] ?? []).some((p) => p.accountKey === member.accountKey)

  return (
    <Modal title={member.name} onClose={onClose}>
      <div className="member-card">
        <Avatar name={member.name} accountKey={member.accountKey} size={64} online={member.online} />
        <div>
          <strong className="member-card-name">{member.name}</strong>
          <div className="muted">{member.role} · {member.online ? 'online' : 'offline'}</div>
          <div className="muted">ID <code>{fingerprint(member.accountKey)}</code></div>
        </div>
      </div>

      {inMyVoice && (
        <section className="settings-section">
          <h3>Voice</h3>
          <label className="field">
            <span>Volume · {Math.round(volume * 100)}%</span>
            <input type="range" min={0} max={2} step={0.05} value={volume} onChange={(e) => setVolume(member.accountKey, Number(e.target.value))} />
          </label>
        </section>
      )}

      {canModerate && connection && (
        <section className="settings-section">
          <h3>Moderation</h3>
          <label className="field inline">
            <span>Role</span>
            <select
              value={member.role}
              onChange={(e) => void run(() => connection.request('member.setRole', { accountKey: member.accountKey, role: e.target.value as Role }))}
            >
              {grantable.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          {confirm ? (
            <div className="copy-row">
              <span>{confirm === 'kick' ? `Remove ${member.name}? They can come back with a new invite.` : `Ban ${member.name}? They can't come back until unbanned.`}</span>
              <button
                className="button danger"
                onClick={() => void run(async () => {
                  await connection.request(confirm === 'kick' ? 'member.kick' : 'member.ban', { accountKey: member.accountKey })
                  onClose()
                })}
              >
                {confirm === 'kick' ? 'Kick' : 'Ban'}
              </button>
              <button className="button" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          ) : (
            <div className="copy-row">
              <button className="button danger-outline" onClick={() => setConfirm('kick')}>Kick</button>
              <button className="button danger-outline" onClick={() => setConfirm('ban')}>Ban</button>
            </div>
          )}
          {error && <p className="error-text">{error}</p>}
        </section>
      )}
    </Modal>
  )
}
