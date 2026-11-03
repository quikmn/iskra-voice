// One toast host with two lanes, so toasts never land on each other:
// - "corner": bottom right, stacked, newest on top; for notes that want a reaction (an update, a warning, an event
//   starting, a call for another account). A card with a mark or icon, a title and a line, an action and ✕.
// - "top": top centre (above the composer on phones), for passing notes ("Sam played airhorn", "Clip saved"). A pill.
// Each toast renders where it is in the React tree (its own state and timers) and portals into its lane.
import { type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Close } from '../icons'
import type { Tone } from './Display'

export type ToastLane = 'corner' | 'top'

/** The lane's element, made once at the end of <body>. */
function laneElement(lane: ToastLane): HTMLElement {
  const id = `toast-lane-${lane}`
  let el = document.getElementById(id)
  if (!el) {
    el = document.createElement('div')
    el.id = id
    el.className = `toast-lane ${lane}`
    document.body.appendChild(el)
  }
  return el
}

/** Puts anything into a lane (for a toast with its own layout, like the recording consent card). */
export function ToastPortal({ lane = 'corner', children }: { lane?: ToastLane; children: ReactNode }) {
  // Rendered to a string (tests, no DOM): in place.
  if (typeof document === 'undefined') return <>{children}</>
  return createPortal(children, laneElement(lane))
}

/** The corner card. Give it `title` and `body`, or your own `children`. */
export function Toast({ tone = 'neutral', mark, icon, title, body, children, action, onClose, closeLabel, closeTitle, className, testId, role = 'status', lane = 'corner' }: {
  tone?: Tone
  /** A filled tile at the start (the update arrow). */
  mark?: ReactNode
  /** A plain icon at the start, in the tone's colour. */
  icon?: ReactNode
  title?: ReactNode
  body?: ReactNode
  children?: ReactNode
  action?: ReactNode
  onClose?: () => void
  closeLabel?: string
  closeTitle?: string
  className?: string
  testId?: string
  role?: 'status' | 'alert' | 'group'
  lane?: ToastLane
}) {
  return (
    <ToastPortal lane={lane}>
      <div className={`toast tone-${tone} ${className ?? ''}`} role={role} aria-live={role === 'group' ? undefined : role === 'alert' ? 'assertive' : 'polite'} data-testid={testId}>
        {mark && <div className="toast-mark" aria-hidden="true">{mark}</div>}
        {!mark && icon && <span className="toast-icon" aria-hidden="true">{icon}</span>}
        {children ?? (
          <div className="toast-text">
            {title && <strong>{title}</strong>}
            {body && <span>{body}</span>}
          </div>
        )}
        {action && <div className="toast-actions">{action}</div>}
        {onClose && closeLabel && (
          <button className="icon-button toast-close" onClick={onClose} aria-label={closeLabel} title={closeTitle ?? closeLabel}>
            <Close size={16} />
          </button>
        )}
      </div>
    </ToastPortal>
  )
}

/** A passing note in the top lane: an icon and a line, maybe a button. */
export function ToastPill({ tone = 'neutral', icon, children, action, className, testId, role = 'status' }: {
  tone?: Tone
  icon?: ReactNode
  children: ReactNode
  action?: ReactNode
  className?: string
  testId?: string
  role?: 'status' | 'alert'
}) {
  return (
    <ToastPortal lane="top">
      <div className={`toast-pill tone-${tone} ${action ? 'has-action' : ''} ${className ?? ''}`} role={role} data-testid={testId}>
        {icon && <span className="toast-icon" aria-hidden="true">{icon}</span>}
        <span className="toast-pill-text">{children}</span>
        {action}
      </div>
    </ToastPortal>
  )
}
