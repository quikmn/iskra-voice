// "Remind me about this": quick times or any time, and an optional private note.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { create } from 'zustand'
import { errorMessage } from '../../i18n/errors'
import { Modal } from '../bits'
import { createReminder } from '../../state/reminders'
import { REMINDER_MAX_AHEAD, type MessageRef, type MessageSnap } from '../../state/productivityLogic'
import { WhenPicker, whenText } from './WhenPicker'

export interface MessageTarget {
  ref: MessageRef
  snap: MessageSnap
}

/** Dialogs opened from message menus live here, so they outlast the menu that opened them. */
export const useMessageDialogs = create<{ remind: MessageTarget | null; done: string | null }>(() => ({ remind: null, done: null }))

export const openRemindDialog = (target: MessageTarget) => useMessageDialogs.setState({ remind: target })

export function RemindDialog({ target, onClose }: { target: MessageTarget; onClose: () => void }) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  /** Undefined until "Pick a date and time" is opened; null while the field isn't a usable time. */
  const [custom, setCustom] = useState<number | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function set(at: number) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await createReminder(target.ref, target.snap, at, note)
      useMessageDialogs.setState({ done: t('productivity.remind.done', { when: whenText(at) }) })
      setTimeout(() => useMessageDialogs.setState({ done: null }), 2500)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('productivity.remind.title')}
      onClose={onClose}
      className="remind-dialog"
      footer={custom !== undefined ? (
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={busy || custom === null} onClick={() => custom && void set(custom)}>{t('productivity.remind.set')}</button>
        </>
      ) : undefined}
    >
      <p className="muted remind-about">{t('productivity.remind.about', { name: target.snap.authorName })}</p>
      {target.snap.preview && <blockquote className="remind-quote">{target.snap.preview}</blockquote>}
      <label className="field">
        <span>{t('productivity.remind.note')}</span>
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('productivity.remind.notePlaceholder')} />
      </label>
      <WhenPicker presets={['20m', '1h', '3h', 'tomorrow', 'nextWeek']} maxAheadMs={REMINDER_MAX_AHEAD} onPick={(at) => void set(at)} onCustom={setCustom} />
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}
