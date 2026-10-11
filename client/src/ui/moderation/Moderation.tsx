// Safety in the chat: collapsed messages from people you blocked, the timed-out composer, the slowmode
// countdown, timeout and block controls for a member, and channel settings (slowmode) for admins.
import { useState, type ReactNode } from 'react'
import { ROLES, roleRank, type Channel, type Member, type Role } from '../../core/protocol'
import { removeTimeout, setBlocked, timeoutMember, useIsBlocked, useMyTimeouts } from '../../state/moderation'
import { countdown, slowmodeLabel, SLOWMODE_STEPS, timeoutActive, TIMEOUT_OPTIONS, untilText } from '../../state/moderationRules'
import { connectionFor, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import { Settings } from '../icons'
import { useServerRoles } from '../../state/roles'
import { has } from '../../state/permissions'
import { ChannelOverrides } from '../roles/RoleSettings'
import { useNow } from './hooks'
import './moderation.css'

export const ClockIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

// ── Blocked messages ────────────────────────────────────────────────────────

/** Messages from someone you blocked collapse to one line until you choose to see them. */
export function BlockGate({ author, children }: { author: string; children: ReactNode }) {
  const blocked = useIsBlocked(author)
  const [shown, setShown] = useState(false)
  if (!blocked || shown) return <>{children}</>
  return (
    <div className="message blocked-message">
      <div className="message-gutter" />
      <div className="message-body">
        <span className="muted">Blocked message</span>
        {' — '}
        <button className="link" onClick={() => setShown(true)}>Show</button>
      </div>
    </div>
  )
}

// ── Timeouts ────────────────────────────────────────────────────────────────

/** A small clock next to a timed-out member's name. */
export function TimeoutBadge({ member }: { member: Member }) {
  const active = timeoutActive(member)
  useNow(active)
  if (!timeoutActive(member)) return null
  return (
    <span className="timeout-badge" title={`Timed out until ${untilText(member.timedOutUntil!)}`} aria-label="Timed out">
      <ClockIcon size={13} />
    </span>
  )
}

/** Takes the composer's place while you're timed out. */
export function TimedOutBar({ server }: { server: ServerState }) {
  const mine = useMyTimeouts((s) => s[server.key])
  const until = server.me?.timedOutUntil ?? 0
  return (
    <div className="composer read-only timed-out-bar" role="status">
      <ClockIcon size={16} />
      <span>
        You're timed out until {untilText(until)}. You can read, but not send, react or join voice until then.
        {mine?.reason && <> Reason: <em>{mine.reason}</em></>}
      </span>
    </div>
  )
}

/** Controls in the member dialog for admins who outrank the member. */
export function TimeoutControls({ server, member }: { server: ServerState; member: Member }) {
  const [duration, setDuration] = useState<number>(TIMEOUT_OPTIONS[1].ms)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = timeoutActive(member)
  useNow(active)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
      setError(null)
      setReason('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="timeout-controls">
      <strong>Timeout</strong>
      {active ? (
        <div className="copy-row">
          <span className="timeout-status"><ClockIcon /> Timed out until {untilText(member.timedOutUntil!)}</span>
          <button className="button small" disabled={busy} onClick={() => void run(() => removeTimeout(server.key, member.accountKey))}>
            Remove timeout
          </button>
        </div>
      ) : (
        <p className="muted">They can still read, but can't send, react, start threads or polls, or use voice and calls here.</p>
      )}
      <div className="timeout-form">
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label="Timeout length">
          {TIMEOUT_OPTIONS.map((o) => <option key={o.ms} value={o.ms}>{o.label}</option>)}
        </select>
        <input
          value={reason} maxLength={200} placeholder="Reason (optional)" aria-label="Timeout reason"
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="button danger-outline" disabled={busy}
          onClick={() => void run(() => timeoutMember(server.key, member.accountKey, duration, reason))}
        >
          {active ? 'Change timeout' : 'Time out'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

// ── Blocking ────────────────────────────────────────────────────────────────

export function BlockButton({ accountKey, name }: { accountKey: string; name: string }) {
  const blocked = useIsBlocked(accountKey)
  const [confirm, setConfirm] = useState(false)
  if (blocked) return <button className="button" onClick={() => void setBlocked(accountKey, false)}>Unblock</button>
  if (!confirm) return <button className="button danger-outline" onClick={() => setConfirm(true)}>Block</button>
  return (
    <div className="block-confirm" role="group" aria-label={`Block ${name}?`}>
      <span>Block {name}? They won't be able to message or call you, and their messages collapse. They aren't told.</span>
      <div className="copy-row">
        <button className="button danger" onClick={() => { void setBlocked(accountKey, true); setConfirm(false) }}>Block</button>
        <button className="button" onClick={() => setConfirm(false)}>Cancel</button>
      </div>
    </div>
  )
}

/** Takes the DM composer's place for someone you blocked. */
export function BlockedDmBar({ accountKey, name }: { accountKey: string; name: string }) {
  return (
    <div className="composer read-only blocked-bar">
      <span>You blocked {name}. Unblock them to send messages or call.</span>
      <button className="button small" onClick={() => void setBlocked(accountKey, false)}>Unblock</button>
    </div>
  )
}

// ── Slowmode ────────────────────────────────────────────────────────────────

export function SlowmodeChip({ seconds, wait }: { seconds: number; wait: number }) {
  if (!seconds) return null
  return (
    <span className={`slowmode-chip ${wait > 0 ? 'waiting' : ''}`} title={`Slowmode: one message every ${slowmodeLabel(seconds)}`} role="status">
      <ClockIcon size={13} />
      {wait > 0 ? countdown(wait) : slowmodeLabel(seconds)}
    </span>
  )
}

// ── Channel settings ────────────────────────────────────────────────────────

export function ChannelSettingsButton({ server, channel }: { server: ServerState; channel: Channel | undefined }) {
  const [open, setOpen] = useState(false)
  const roles = useServerRoles(server.key)
  if (!channel || !has(server.me, roles, 'manageChannels')) return null
  return (
    <>
      <button className="icon-button" onClick={() => setOpen(true)} aria-label="Channel settings" title="Channel settings">
        <Settings size={18} />
      </button>
      {open && <ChannelSettingsDialog server={server} channel={channel} onClose={() => setOpen(false)} />}
    </>
  )
}

function ChannelSettingsDialog({ server, channel, onClose }: { server: ServerState; channel: Channel; onClose: () => void }) {
  const [name, setName] = useState(channel.name)
  const [readRole, setReadRole] = useState<Role>(channel.readRole)
  const [writeRole, setWriteRole] = useState<Role>(channel.writeRole)
  const [slowmode, setSlowmodeValue] = useState(channel.slowmode ?? 0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const connection = connectionFor(server.key)
      if (!connection) throw new Error('Not connected.')
      await connection.request('channel.update', {
        id: channel.id, name: name.trim() || channel.name, readRole, writeRole,
        slowmode: channel.kind === 'text' ? slowmode : undefined,
      })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`#${channel.name} settings`}
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </label>
      <div className="channel-roles">
        <label className="field">
          <span>Who can read</span>
          <select value={readRole} onChange={(e) => {
            const role = e.target.value as Role
            setReadRole(role)
            if (roleRank(writeRole) < roleRank(role)) setWriteRole(role)
          }}>
            {ROLES.map((r) => <option key={r} value={r}>{r} and up</option>)}
          </select>
        </label>
        <label className="field">
          <span>Who can write</span>
          <select value={writeRole} onChange={(e) => setWriteRole(e.target.value as Role)}>
            {ROLES.filter((r) => roleRank(r) >= roleRank(readRole)).map((r) => <option key={r} value={r}>{r} and up</option>)}
          </select>
        </label>
      </div>
      {channel.kind === 'text' && (
        <label className="field">
          <span>Slowmode · {slowmode ? `one message every ${slowmodeLabel(slowmode)}` : 'off'}</span>
          <input
            type="range" min={0} max={SLOWMODE_STEPS.length - 1} step={1} aria-label="Slowmode"
            value={SLOWMODE_STEPS.indexOf(slowmode as (typeof SLOWMODE_STEPS)[number])}
            onChange={(e) => setSlowmodeValue(SLOWMODE_STEPS[Number(e.target.value)])}
          />
          <small className="muted">Members can send one message per interval here. Admins and moderators aren't limited.</small>
        </label>
      )}
      {error && <p className="error-text">{error}</p>}
      <ChannelOverrides server={server} channel={channel} />
    </Modal>
  )
}
