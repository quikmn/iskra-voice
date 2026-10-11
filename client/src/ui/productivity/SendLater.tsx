// "Send later" from a composer: a clock button, and right-click or press-and-hold on the send button.
import { useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { dmErrorText } from '../../state/dms'
import { Modal } from '../bits'
import { scheduleMessage, type ScheduleTarget } from '../../state/scheduled'
import { CHANNEL_SEND_MAX_AHEAD, ENCRYPTED_SEND_MAX_AHEAD } from '../../state/productivityLogic'
import { WhenPicker, whenText } from './WhenPicker'
import { useMessageDialogs } from './RemindDialog'
import { Clock } from './icons'
import './productivity.css'

/**
 * `prepare` gives the text to send (as the composer would) or null if there's nothing to schedule; `blocked` is a reason
 * it can't be scheduled right now (e.g. files attached). `onScheduled` clears the composer.
 */
export function useSendLater({ target, prepare, blocked, disabled, onScheduled }: {
  target: ScheduleTarget
  prepare: () => string | null
  blocked?: string | null
  disabled?: boolean
  onScheduled: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<{ text: string | null } | null>(null)
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)

  const start = () => !disabled && setOpen({ text: prepare() })
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current)
    hold.current = null
  }

  return {
    button: (
      <button className="icon-button attach-button send-later-button" onClick={start} disabled={disabled}
        aria-label={t('productivity.sendLater.button')} title={`${t('productivity.sendLater.button')} · ${t('productivity.sendLater.hint')}`}>
        <Clock />
      </button>
    ),
    /** Spread on the send button. */
    sendProps: {
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault()
        cancelHold()
        start()
      },
      onPointerDown: (e: PointerEvent) => {
        held.current = false
        if (e.pointerType !== 'touch') return
        hold.current = setTimeout(() => {
          held.current = true
          navigator.vibrate?.(10)
          start()
        }, 500)
      },
      onPointerUp: cancelHold,
      onPointerLeave: cancelHold,
      onPointerCancel: cancelHold,
      onClickCapture: (e: MouseEvent) => {
        if (!held.current) return
        e.preventDefault()
        e.stopPropagation()
        held.current = false
      },
    },
    dialog: open && (
      <SendLaterDialog target={target} text={open.text} blocked={blocked ?? null} onClose={() => setOpen(null)} onScheduled={() => {
        setOpen(null)
        onScheduled()
      }} />
    ),
  }
}

function SendLaterDialog({ target, text, blocked, onClose, onScheduled }: {
  target: ScheduleTarget; text: string | null; blocked: string | null; onClose: () => void; onScheduled: () => void
}) {
  const { t } = useTranslation()
  const [custom, setCustom] = useState<number | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const encrypted = target.kind !== 'channel'
  const problem = blocked ?? (text ? null : t('productivity.sendLater.empty'))

  async function schedule(at: number) {
    if (busy || !text || problem) return
    setBusy(true)
    setError(null)
    try {
      await scheduleMessage(target, text, at)
      useMessageDialogs.setState({ done: t('productivity.sendLater.scheduledFor', { when: whenText(at) }) })
      setTimeout(() => useMessageDialogs.setState({ done: null }), 2500)
      onScheduled()
    } catch (e) {
      setError(encrypted ? dmErrorText(e) : errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('productivity.sendLater.title')}
      onClose={onClose}
      className="send-later-dialog"
      footer={custom !== undefined && !problem ? (
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={busy || custom === null} onClick={() => custom && void schedule(custom)}>{t('productivity.sendLater.schedule')}</button>
        </>
      ) : undefined}
    >
      {problem ? <p className="muted">{problem}</p> : (
        <>
          <blockquote className="remind-quote">{text}</blockquote>
          {encrypted && <p className="muted small-note">{t('productivity.sendLater.encrypted')}</p>}
          <WhenPicker presets={['1h', '3h', 'tomorrow', 'nextWeek']} maxAheadMs={encrypted ? ENCRYPTED_SEND_MAX_AHEAD : CHANNEL_SEND_MAX_AHEAD}
            onPick={(at) => void schedule(at)} onCustom={setCustom} />
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}
