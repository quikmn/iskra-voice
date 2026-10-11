import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { fingerprint } from '../../core/connection'
import { ROLES, roleRank, type Member, type Role } from '../../core/protocol'
import { connectionFor, type ServerState } from '../../state/store'
import { maxVolume, setVolume, useVoice } from '../../state/voice'
import { openConversation } from '../../state/dms'
import { FriendButtons } from '../people/Friends'
import { Avatar, Modal } from '../bits'
import { removeMemberPage } from '../../state/profile'
import { BotBadge } from '../chat/BotBits'
import { useMemberPresence } from '../../state/presence'
import { STATUS_LABELS } from '../../state/presenceRules'
import { BlockButton, ClockIcon, TimeoutControls } from '../moderation/Moderation'
import { timeoutActive, untilText } from '../../state/moderationRules'
import { NicknameField } from '../organize/ServerSettings'
import { useServerRoles } from '../../state/roles'
import { has, outranks } from '../../state/permissions'
import { MemberRolesEditor, RoleChips, VoiceModControls } from '../roles/RoleSettings'

export function MemberDialog({ server, member, onClose }: { server: ServerState; member: Member; onClose: () => void }) {
  const { t } = useTranslation()
  const me = server.me
  const isSelf = me?.accountKey === member.accountKey
  const roles = useServerRoles(server.key)
  const below = !isSelf && outranks(me, member, roles)
  // Levels and profile pages stay with admins; the rest comes from permissions (custom roles).
  const canModerate = !!me && !isSelf && roleRank(me.role) >= roleRank('admin') && roleRank(me.role) > roleRank(member.role)
  const canKick = below && has(me, roles, 'kickMembers')
  const canBan = below && has(me, roles, 'banMembers')
  const canTimeout = below && has(me, roles, 'timeoutMembers')
  const grantable = me ? ROLES.filter((r) => roleRank(r) < roleRank(me.role)) : []
  const [confirm, setConfirm] = useState<'kick' | 'ban' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const presence = useMemberPresence(member)

  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
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
        <Avatar name={member.name} accountKey={member.accountKey} size={64} status={presence.status} />
        <div>
          <strong className="member-card-name">{member.name}</strong> {member.bot && <BotBadge />}
          {member.nick && member.profileName && <div className="muted">{member.profileName}</div>}
          <div className="muted">{[member.pronouns, t(`common.roles.${member.role}`), STATUS_LABELS[presence.status].toLowerCase()].filter(Boolean).join(' · ')}</div>
          <div className="muted">{t('settings.member.id')} <code>{fingerprint(member.accountKey)}</code></div>
          <RoleChips server={server} member={member} />
          {timeoutActive(member) && (
            <div className="member-timeout-line"><ClockIcon /> {t('settings.member.timedOutUntil', { until: untilText(member.timedOutUntil!) })}</div>
          )}
        </div>
      </div>

      {!isSelf && (
        <div className="copy-row member-actions">
          <button className="button primary" onClick={() => { openConversation(member.accountKey); onClose() }}>{t('settings.member.message')}</button>
          <FriendButtons accountKey={member.accountKey} />
          <BlockButton accountKey={member.accountKey} name={member.name} />
        </div>
      )}

      {inMyVoice && (
        <section className="settings-section">
          <h3>{t('settings.member.voice')}</h3>
          <label className="field">
            <span>{t('settings.member.volume', { percent: Math.round(volume * 100) })}</span>
            <input type="range" min={0} max={maxVolume()} step={0.05} value={Math.min(volume, maxVolume())} onChange={(e) => setVolume(member.accountKey, Number(e.target.value))} />
          </label>
        </section>
      )}

      <NicknameField server={server} member={member} />
      <MemberRolesEditor server={server} member={member} />
      <VoiceModControls server={server} member={member} />

      {(canModerate || canKick || canBan || canTimeout) && connection && (
        <section className="settings-section">
          <h3>{t('settings.member.moderation')}</h3>
          {canModerate && <label className="field inline">
            <span>{t('settings.member.level')}</span>
            <select
              value={member.role}
              onChange={(e) => void run(() => connection.request('member.setRole', { accountKey: member.accountKey, role: e.target.value as Role }))}
            >
              {grantable.map((r) => <option key={r} value={r}>{t(`common.roles.${r}`)}</option>)}
            </select>
          </label>}
          {canModerate && member.page && (
            <div className="copy-row member-actions">
              <button className="button danger-outline" onClick={() => void run(() => removeMemberPage(server.key, member))}>{t('settings.member.removePage')}</button>
            </div>
          )}
          {confirm ? (
            <div className="copy-row">
              <span>{confirm === 'kick' ? t('settings.member.kickConfirm', { name: member.name }) : t('settings.member.banConfirm', { name: member.name })}</span>
              <button
                className="button danger"
                onClick={() => void run(async () => {
                  await connection.request(confirm === 'kick' ? 'member.kick' : 'member.ban', { accountKey: member.accountKey })
                  onClose()
                })}
              >
                {confirm === 'kick' ? t('settings.member.kick') : t('settings.member.ban')}
              </button>
              <button className="button" onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
            </div>
          ) : (canKick || canBan) && (
            <div className="copy-row">
              {canKick && <button className="button danger-outline" onClick={() => setConfirm('kick')}>{t('settings.member.kick')}</button>}
              {canBan && <button className="button danger-outline" onClick={() => setConfirm('ban')}>{t('settings.member.ban')}</button>}
            </div>
          )}
          {error && <p className="error-text">{error}</p>}
          {canTimeout && <TimeoutControls server={server} member={member} />}
        </section>
      )}
    </Modal>
  )
}
