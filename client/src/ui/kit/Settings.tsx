// Settings building blocks. The save model (one rule everywhere):
// - a switch, select or slider saves the moment it changes, and shows a quiet "Saved" tick next to it;
// - text fields and multi-field forms (profile, AutoMod, a role) keep a draft and show the unsaved-changes bar
//   (SaveBar), docked to the bottom of the pane. No Save button in the body, no Cancel/Save footer.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '../bits'
import { Check } from '../icons'
import { Switch } from './Switch'

/**
 * True for a moment after `value` changes (never on the first render). The value is what the app holds (the server's
 * reply, the stored preference), so the tick means it stuck.
 */
export function useSavedFlash(value: unknown, ms = 1600): boolean {
  const key = JSON.stringify(value ?? null)
  const previous = useRef(key)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (previous.current === key) return
    previous.current = key
    setShown(true)
    const timer = setTimeout(() => setShown(false), ms)
    return () => clearTimeout(timer)
  }, [key, ms])
  return shown
}

/** "✓ Saved", announced politely. The live region is always there, so the change is read out. */
export function SavedTick({ shown }: { shown: boolean }) {
  const { t } = useTranslation()
  return (
    <span className={`k-saved ${shown ? 'shown' : ''}`} role="status">
      {shown && <><Check size={14} />{t('common.saved')}</>}
    </span>
  )
}

/**
 * One setting: title and help on the left, its control on the right (a switch, a select, a button). `value` is what
 * the control shows; when it changes, the row says "Saved".
 */
export function SettingRow({ title, help, control, value, children, className, testId, titleId, helpId }: {
  title: ReactNode
  help?: ReactNode
  control: ReactNode
  value?: unknown
  /** More of this setting under the row (shown when it's on, for example). */
  children?: ReactNode
  className?: string
  testId?: string
  titleId?: string
  helpId?: string
}) {
  const saved = useSavedFlash(value)
  return (
    <div className={`k-row ${className ?? ''}`} data-testid={testId}>
      <div className="k-row-main">
        <div className="k-row-text">
          <span className="k-row-title" id={titleId}>{title}</span>
          {help && <span className="k-row-help" id={helpId}>{help}</span>}
        </div>
        {value !== undefined && <SavedTick shown={saved} />}
        <div className="k-row-control">{control}</div>
      </div>
      {children && <div className="k-row-more">{children}</div>}
    </div>
  )
}

/** A setting that is a switch: the row's title names it and its help describes it, unless `label` names it. */
export function SwitchRow({ title, help, checked, onChange, disabled, label, children, className, testId }: {
  title: ReactNode
  help?: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** An accessible name that differs from the title (kept for names people and tests already know). */
  label?: string
  children?: ReactNode
  className?: string
  testId?: string
}) {
  const id = useId()
  return (
    <SettingRow
      title={title}
      help={help}
      titleId={`${id}-t`}
      helpId={help ? `${id}-h` : undefined}
      value={checked}
      className={className}
      testId={testId}
      control={<Switch checked={checked} onChange={onChange} disabled={disabled} label={label} labelledBy={`${id}-t`} describedBy={help ? `${id}-h` : undefined} />}
    >
      {children}
    </SettingRow>
  )
}

/**
 * A labelled control with optional help and error lines. Pass a function to wire the label to the control by id
 * (help and error then describe it); a plain child is wrapped in the label.
 */
export function Field({ label, help, error, children, className, inline }: {
  label: ReactNode
  help?: ReactNode
  error?: ReactNode
  children: ReactNode | ((props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode)
  className?: string
  inline?: boolean
}) {
  const id = useId()
  const classes = `field ${inline ? 'inline' : ''} ${className ?? ''}`
  if (typeof children !== 'function') {
    return (
      <div className={classes}>
        <label className="k-field-label">
          <span>{label}</span>
          {children}
        </label>
        {help && <small className="k-field-help">{help}</small>}
        {error && <small className="k-field-error" role="alert">{error}</small>}
      </div>
    )
  }
  const described = [help ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className={classes}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': described, 'aria-invalid': error ? true : undefined })}
      {help && <small className="k-field-help" id={`${id}-h`}>{help}</small>}
      {error && <small className="k-field-error" id={`${id}-e`} role="alert">{error}</small>}
    </div>
  )
}

/**
 * The unsaved-changes bar for a form in settings, docked to the bottom of the pane while there's something to say:
 * "You have unsaved changes · Undo · Save changes", the problem that blocks saving, or the error from the last try.
 * After a save it says "Saved" for a moment.
 */
export function SaveBar({ dirty, busy, problem, error, savedNote, onUndo, onSave, saveLabel, className, testId }: {
  dirty: boolean
  busy?: boolean
  /** Why it can't be saved as it is (shown instead of the unsaved note; Save is off). */
  problem?: string | null
  error?: string | null
  /** What the last save did, said in place of the plain "Saved" (kept until the next edit). */
  savedNote?: string | null
  onUndo: () => void
  onSave: () => void
  saveLabel?: string
  className?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const [justSaved, setJustSaved] = useState(false)
  const wasBusy = useRef(false)
  // A save finished cleanly: the draft matches again.
  useEffect(() => {
    if (wasBusy.current && !busy && !dirty && !error) {
      setJustSaved(true)
      const timer = setTimeout(() => setJustSaved(false), 1800)
      wasBusy.current = false
      return () => clearTimeout(timer)
    }
    wasBusy.current = !!busy
  }, [busy, dirty, error])
  const show = dirty || !!problem || !!error
  return (
    <div className={`k-savebar ${show ? 'show' : ''} ${(justSaved || savedNote) && !show ? 'saved' : ''} ${className ?? ''}`} data-testid={testId}>
      <span className="k-savebar-note" role="status">
        {problem ? <span className="error-text">{problem}</span>
          : error ? <span className="error-text">{error}</span>
          : dirty ? t('kit.unsaved')
          : savedNote ? <><Check size={14} /> {savedNote}</>
          : justSaved ? <><Check size={14} /> {t('common.saved')}</> : ''}
      </span>
      {show && (
        <div className="k-savebar-actions">
          <button className="button ghost" disabled={!dirty || busy} onClick={onUndo}>{t('common.undo')}</button>
          <button className="button primary" disabled={!dirty || busy || !!problem} onClick={onSave}>
            {busy ? <Spinner /> : saveLabel ?? t('kit.saveChanges')}
          </button>
        </div>
      )}
    </div>
  )
}
