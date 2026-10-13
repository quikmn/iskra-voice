// Safety in the chat: collapsed messages from people you blocked, the timed-out composer, the slowmode
// countdown, timeout and block controls for a member, and channel settings (slowmode) for admins.
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import type { Channel, Member } from '../../core/protocol'
import { removeTimeout, setBlocked, timeoutMember, useIsBlocked, useMyTimeouts } from '../../state/moderation'
import { countdown, durationLabel, slowmodeLabel, timeoutActive, TIMEOUT_OPTIONS, untilText } from '../../state/moderationRules'
import type { ServerState } from '../../state/store'
import { ChannelSettingsDialog } from '../organize/Dialogs'
import { Sliders } from '../icons'
import { useServerRoles } from '../../state/roles'
import { has } from '../../state/permissions'
import { useNow } from './hooks'
import { blockPerson } from '../../state/friends'
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
  const { t } = useTranslation()
  const blocked = useIsBlocked(author)
  const [shown, setShown] = useState(false)
  if (!blocked || shown) return <>{children}</>
  return (
    <div className="message blocked-message">
      <div className="message-gutter" />
      <div className="message-body">
        <span className="muted">{t('moderation.blocked.message')}</span>
        {' — '}
        <button className="link" onClick={() => setShown(true)}>{t('moderation.blocked.show')}</button>
      </div>
    </div>
  )
}

// ── Timeouts ────────────────────────────────────────────────────────────────

/** A small clock next to a timed-out member's name. */
export function TimeoutBadge({ member }: { member: Member }) {
  const { t } = useTranslation()
  const active = timeoutActive(member)
  useNow(active)
  if (!timeoutActive(member)) return null
  return (
    <span className="timeout-badge" title={t('moderation.timeout.badgeTitle', { until: untilText(member.timedOutUntil!) })} aria-label={t('moderation.timeout.badge')}>
      <ClockIcon size={13} />
    </span>
  )
}

/** Takes the composer's place while you're timed out. */
export function TimedOutBar({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const mine = useMyTimeouts((s) => s[server.key])
  const until = server.me?.timedOutUntil ?? 0
  return (
    <div className="composer read-only timed-out-bar" role="status">
      <ClockIcon size={16} />
      <span>
        {t('moderation.timeout.bar', { until: untilText(until) })}
        {mine?.reason && <> {t('moderation.timeout.reason')} <em>{mine.reason}</em></>}
      </span>
    </div>
  )
}

/** Controls in the member dialog for admins who outrank the member. */
export function TimeoutControls({ server, member }: { server: ServerState; member: Member }) {
  const { t } = useTranslation()
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
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="timeout-controls">
      <strong>{t('moderation.timeout.title')}</strong>
      {active ? (
        <div className="copy-row">
          <span className="timeout-status"><ClockIcon /> {t('moderation.timeout.until', { until: untilText(member.timedOutUntil!) })}</span>
          <button className="button small" disabled={busy} onClick={() => void run(() => removeTimeout(server.key, member.accountKey))}>
            {t('moderation.timeout.remove')}
          </button>
        </div>
      ) : (
        <p className="muted">{t('moderation.timeout.explain')}</p>
      )}
      <div className="timeout-form">
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} aria-label={t('moderation.timeout.length')}>
          {TIMEOUT_OPTIONS.map((o) => <option key={o.ms} value={o.ms}>{durationLabel(o.ms)}</option>)}
        </select>
        <input
          value={reason} maxLength={200} placeholder={t('moderation.timeout.reasonPlaceholder')} aria-label={t('moderation.timeout.reasonLabel')}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="button danger-outline" disabled={busy}
          onClick={() => void run(() => timeoutMember(server.key, member.accountKey, duration, reason))}
        >
          {active ? t('moderation.timeout.change') : t('moderation.timeout.timeOut')}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

// ── Blocking ────────────────────────────────────────────────────────────────

export function BlockButton({ accountKey, name }: { accountKey: string; name: string }) {
  const { t } = useTranslation()
  const blocked = useIsBlocked(accountKey)
  const [confirm, setConfirm] = useState(false)
  if (blocked) return <button className="button" onClick={() => void setBlocked(accountKey, false)}>{t('moderation.blocked.unblock')}</button>
  if (!confirm) return <button className="button danger-outline" onClick={() => setConfirm(true)}>{t('moderation.blocked.block')}</button>
  return (
    <div className="block-confirm" role="group" aria-label={t('moderation.blocked.confirmLabel', { name })}>
      <span>{t('moderation.blocked.confirm', { name })}</span>
      <div className="copy-row">
        <button className="button danger" onClick={() => { void blockPerson(accountKey); setConfirm(false) }}>{t('moderation.blocked.block')}</button>
        <button className="button" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

/** Takes the DM composer's place for someone you blocked. */
export function BlockedDmBar({ accountKey, name }: { accountKey: string; name: string }) {
  const { t } = useTranslation()
  return (
    <div className="composer read-only blocked-bar">
      <span>{t('moderation.blocked.dmBar', { name })}</span>
      <button className="button small" onClick={() => void setBlocked(accountKey, false)}>{t('moderation.blocked.unblock')}</button>
    </div>
  )
}

// ── Slowmode ────────────────────────────────────────────────────────────────

export function SlowmodeChip({ seconds, wait }: { seconds: number; wait: number }) {
  const { t } = useTranslation()
  if (!seconds) return null
  return (
    <span className={`slowmode-chip ${wait > 0 ? 'waiting' : ''}`} title={t('moderation.slowmode.chipTitle', { every: slowmodeLabel(seconds) })} role="status">
      <ClockIcon size={13} />
      {wait > 0 ? countdown(wait) : slowmodeLabel(seconds)}
    </span>
  )
}

// ── Channel settings ────────────────────────────────────────────────────────

export function ChannelSettingsButton({ server, channel }: { server: ServerState; channel: Channel | undefined }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const roles = useServerRoles(server.key)
  if (!channel || !has(server.me, roles, 'manageChannels')) return null
  return (
    <>
      <button className="icon-button" onClick={() => setOpen(true)} aria-label={t('moderation.channelSettings')} title={t('moderation.channelSettings')}>
        <Sliders size={18} />
      </button>
      {open && <ChannelSettingsDialog server={server} channel={channel} onClose={() => setOpen(false)} />}
    </>
  )
}
