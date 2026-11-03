// Disappearing messages UI: the timer button in a conversation's header (also its badge), the dialog that sets it, the
// line shown when someone changes it, and the small timer on messages that will disappear.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DISAPPEAR_TIMERS } from '../../core/disappear'
import { errorMessage } from '../../i18n/errors'
import { Modal } from '../bits'
import { fullTime, messageTime } from '../format'
import './disappear.css'

export function TimerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 2h4" />
      <path d="M12 14l3-3" />
      <circle cx="12" cy="14" r="8" />
    </svg>
  )
}

type Kind = 'dm' | 'group' | 'channel'

/**
 * The timer in a conversation header. While it's on it shows as an icon with the time (the conversation's badge);
 * while it's off it's a row in the header's "⋯" (`item`), or nothing when you can't change it. Both open the dialog.
 */
export function useDisappearTool({ kind, seconds, canChange, onSet }: {
  kind: Kind
  seconds: number
  canChange: boolean
  onSet: (seconds: number) => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const state = seconds ? t(`disappear.timers.${seconds}` as 'disappear.timers.300') : t('disappear.timers.0')
  return {
    on: seconds > 0,
    button: seconds > 0 ? (
      <button
        className="icon-button disappear-button on"
        onClick={() => setOpen(true)}
        aria-label={t('disappear.button', { state })}
        title={t('disappear.button', { state })}
        data-testid="disappear-button"
      >
        <TimerIcon />
        <span className="disappear-short">{t(`disappear.short.${seconds}` as 'disappear.short.300')}</span>
      </button>
    ) : null,
    item: !seconds && canChange
      ? { key: 'disappear', label: t('disappear.title'), icon: <TimerIcon />, onSelect: () => setOpen(true), testId: 'disappear-item' }
      : null,
    dialog: open && <DisappearDialog kind={kind} seconds={seconds} canChange={canChange} onSet={onSet} onClose={() => setOpen(false)} />,
  }
}

export function DisappearDialog({ kind, seconds, canChange, onSet, onClose }: {
  kind: Kind
  seconds: number
  canChange: boolean
  onSet: (seconds: number) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const choose = async (value: number) => {
    if (value === seconds || busy !== null) return
    setBusy(value)
    setError(null)
    try {
      await onSet(value)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal title={t('disappear.title')} onClose={onClose} className="disappear-dialog">
      <p>{t(`disappear.intro.${kind}`)}</p>
      <div className="disappear-options" role="radiogroup" aria-label={t('disappear.title')}>
        {DISAPPEAR_TIMERS.map((value) => (
          <label key={value} className={`disappear-option ${value === seconds ? 'chosen' : ''}`}>
            <input
              type="radio"
              name="disappear-timer"
              checked={value === seconds}
              disabled={!canChange || busy !== null}
              onChange={() => void choose(value)}
            />
            <span>{t(`disappear.timers.${value}` as 'disappear.timers.0')}</span>
            {busy === value && <span className="muted">{t('disappear.saving')}</span>}
          </label>
        ))}
      </div>
      {!canChange && <p className="muted">{t('disappear.managersOnly')}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted">{t('disappear.newOnly')}</p>
      <p className="muted">{t('disappear.deleted')}</p>
      <p className="disappear-honest">{t('disappear.honest')}</p>
    </Modal>
  )
}

/** "Alex set new messages to disappear after 1 day." */
export function DisappearLine({ seconds, name, mine, at }: { seconds: number; name: string; mine: boolean; at: number }) {
  const { t } = useTranslation()
  const duration = seconds ? t(`disappear.timers.${seconds}` as 'disappear.timers.300') : ''
  const text = seconds
    ? t(mine ? 'disappear.line.onYou' : 'disappear.line.on', { name, duration })
    : t(mine ? 'disappear.line.offYou' : 'disappear.line.off', { name })
  return (
    <div className="disappear-line" role="note">
      <span className="disappear-line-icon"><TimerIcon size={14} /></span>
      <span>{text}</span>
      <time title={fullTime(at)}>{messageTime(at)}</time>
    </div>
  )
}

/** The small timer on a message that will disappear. */
export function ExpiryBadge({ expiresAt }: { expiresAt?: number | null }) {
  const { t } = useTranslation()
  if (typeof expiresAt !== 'number') return null
  const label = t('disappear.expires', { time: fullTime(expiresAt) })
  return (
    <span className="expiry-badge" title={label} aria-label={label} role="img">
      <TimerIcon size={12} />
    </span>
  )
}
