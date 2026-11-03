// Display pieces: Badge (a status tag), Chip (a filter you turn on and off), ListRow, EmptyState.
import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/**
 * A small status tag: "This device", "Experimental", "Built-in". Sentence case; `system` keeps short system tags
 * (BOT, LIVE) in capitals.
 */
export function Badge({ tone = 'neutral', size = 'sm', dot, icon, system, children, className, title, testId }: {
  tone?: Tone
  size?: 'xs' | 'sm'
  dot?: boolean
  icon?: ReactNode
  system?: boolean
  children: ReactNode
  className?: string
  title?: string
  testId?: string
}) {
  return (
    <span className={`k-badge tone-${tone} size-${size} ${system ? 'system' : ''} ${className ?? ''}`} title={title} data-testid={testId}>
      {dot && <span className="k-badge-dot" aria-hidden />}
      {icon}
      {children}
    </span>
  )
}

/** A filter or pick that turns on and off (a toggle button). */
export function Chip({ on, onToggle, icon, children, disabled, className, label, testId }: {
  on: boolean
  onToggle: (next: boolean) => void
  icon?: ReactNode
  children: ReactNode
  disabled?: boolean
  className?: string
  label?: string
  testId?: string
}) {
  return (
    <button type="button" className={`k-chip ${on ? 'on' : ''} ${className ?? ''}`} aria-pressed={on} aria-label={label}
      disabled={disabled} onClick={() => onToggle(!on)} data-testid={testId}>
      {icon}
      <span className="k-chip-text">{children}</span>
    </button>
  )
}

/**
 * One row of a list: a leading avatar or icon, a title over a sub line, trailing actions (shown on hover on desktop,
 * always on touch screens, unless `actionsAlways`). Compact rows are 36px, comfortable ones 56px.
 */
export function ListRow({ leading, title, sub, trailing, density = 'comfortable', actionsAlways, onClick, active, className, testId, label }: {
  leading?: ReactNode
  title: ReactNode
  sub?: ReactNode
  trailing?: ReactNode
  density?: 'compact' | 'comfortable'
  actionsAlways?: boolean
  /** Makes the row's main part a button (the trailing actions stay their own buttons). */
  onClick?: () => void
  active?: boolean
  className?: string
  testId?: string
  label?: string
}) {
  const body = (
    <>
      {leading && <span className="k-list-lead">{leading}</span>}
      <span className="k-list-text">
        <span className="k-list-title">{title}</span>
        {sub && <span className="k-list-sub">{sub}</span>}
      </span>
    </>
  )
  return (
    <div className={`k-list-row ${density} ${active ? 'active' : ''} ${actionsAlways ? 'actions-always' : ''} ${className ?? ''}`} data-testid={testId}>
      {onClick
        ? <button type="button" className="k-list-main" onClick={onClick} aria-label={label} aria-current={active ? 'true' : undefined}>{body}</button>
        : <div className="k-list-main">{body}</div>}
      {trailing && <span className="k-list-actions">{trailing}</span>}
    </div>
  )
}

/**
 * Nothing here yet. `page`: an icon in a 72px circle, a title, one line and one action (a whole view). `panel`: a
 * smaller version for a side panel or a section. `inline`: one muted line with an icon, inside a list.
 */
export function EmptyState({ icon, title, body, action, size = 'panel', className, testId }: {
  icon?: ReactNode
  title?: ReactNode
  body?: ReactNode
  action?: ReactNode
  size?: 'page' | 'panel' | 'inline'
  className?: string
  testId?: string
}) {
  if (size === 'inline') {
    return (
      <p className={`k-empty inline ${className ?? ''}`} data-testid={testId}>
        {icon && <span className="k-empty-icon" aria-hidden>{icon}</span>}
        <span>{title}{title && body ? ' ' : ''}{body}</span>
      </p>
    )
  }
  return (
    <div className={`k-empty ${size} ${className ?? ''}`} data-testid={testId}>
      {icon && <span className="k-empty-icon" aria-hidden>{icon}</span>}
      {title && <p className="k-empty-title">{title}</p>}
      {body && <p className="k-empty-body">{body}</p>}
      {action && <div className="k-empty-action">{action}</div>}
    </div>
  )
}
