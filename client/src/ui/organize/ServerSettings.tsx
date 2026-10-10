// "This server" pieces for settings: your notification level and mute here, and nicknames.
import { useState } from 'react'
import { roleRank, type Member, type NotifyLevel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { muteFor, setNickname, setNotifyLevel, useNotifyFor, useOrganize } from '../../state/organize'
import { LEVEL_LABELS, MUTE_CHOICES, muteLabel } from '../../state/organizeLogic'
import './organize.css'

/** Level and mute for a whole server. Channels can override the level from their own menu. */
export function ServerNotifySettings({ server }: { server: ServerState }) {
  const notify = useNotifyFor(server.key, null)
  const own = useOrganize((s) => s.notify[server.key]?.server)
  const [error, setError] = useState<string | null>(null)
  const clock = useOrganize((s) => s.clock)
  const muted = muteLabel(own?.mutedUntil ?? null, clock)
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: Error) => setError(e.message))
  }
  return (
    <div className="org-notify" role="group" aria-label={`Notifications for ${server.name}`}>
      <h4>On {server.name}, notify me about</h4>
      <div className="segmented" role="radiogroup" aria-label="Notify me about">
        {(['all', 'mentions', 'none'] as NotifyLevel[]).map((level) => (
          <button key={level} role="radio" aria-checked={notify.chosen === level} className={notify.chosen === level ? 'on' : ''}
            onClick={() => run(() => setNotifyLevel(server.key, null, level))}>
            {LEVEL_LABELS[level]}
          </button>
        ))}
      </div>
      <div className="org-notify-row">
        {muted ? (
          <>
            <span className="muted">{muted}</span>
            <button className="button" onClick={() => run(() => muteFor(server.key, null, 0))}>Unmute server</button>
          </>
        ) : (
          <label className="field inline">
            <span>Mute server</span>
            <select value="" aria-label="Mute server" onChange={(e) => e.target.value && run(() => muteFor(server.key, null, Number(e.target.value)))}>
              <option value="">Not muted</option>
              {MUTE_CHOICES.map((c) => <option key={c.minutes} value={c.minutes}>{c.label}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="muted">
        Applies to this device's notifications and to push on all your devices. Muted channels and servers are dimmed and only
        badge for @mentions. Pick a level for a single channel from its ⋯ menu.
      </p>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

/** Your nickname on a server, or (admins, for members ranked below them) someone else's. */
export function NicknameField({ server, member: given }: { server: ServerState; member: Member }) {
  const member = server.members[given.accountKey] ?? given // the latest copy
  const me = server.me
  const isSelf = me?.accountKey === member.accountKey
  const canEdit = !!me && (isSelf || (roleRank(me.role) >= roleRank('admin') && roleRank(me.role) > roleRank(member.role)))
  const [value, setValue] = useState(member.nick ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  if (!canEdit) return null
  const trimmed = value.trim()
  const changed = trimmed !== (member.nick ?? '')

  async function save(nick: string) {
    setError(null)
    setSaved(false)
    try {
      await setNickname(server.key, nick, isSelf ? undefined : member.accountKey)
      setValue(nick)
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="org-nick">
      <div className="org-nick-row">
        <label className="field">
          <span>{isSelf ? 'Your nickname on this server' : 'Nickname on this server'}</span>
          <input value={value} maxLength={32} placeholder={member.profileName ?? member.name}
            onChange={(e) => { setValue(e.target.value); setSaved(false) }}
            onKeyDown={(e) => e.key === 'Enter' && changed && void save(trimmed)} />
        </label>
        <button className="button primary" disabled={!changed} onClick={() => void save(trimmed)}>Save</button>
        {member.nick && <button className="button" onClick={() => void save('')}>Reset</button>}
      </div>
      <p className="muted">
        {saved ? 'Saved.' : `Shown instead of ${isSelf ? 'your' : 'their'} profile name everywhere on ${server.name}. The profile card still shows the real name.`}
      </p>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
