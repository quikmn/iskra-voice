// Two ways to pick one of a few, with clear jobs:
// - Tabs (an underline bar) switch between views: friends, the inbox, the moderation sheet.
// - Segmented (a filled control) picks one of 2–4 values inside a form: voice activity or push to talk.
// Filters stay chips (Chip in Display.tsx).
import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface TabItem<Id extends string> {
  id: Id
  label: ReactNode
  /** A number after the label (unread, waiting). */
  count?: number
  /** The accessible name when the label isn't plain text. */
  name?: string
  icon?: ReactNode
  disabled?: boolean
  testId?: string
}

/** Arrow keys, Home and End move along a row of buttons and pick the one they land on. */
function moveWith<Id extends string>(e: KeyboardEvent, items: TabItem<Id>[], value: Id, pick: (id: Id) => void, root: HTMLElement | null) {
  const usable = items.filter((i) => !i.disabled)
  const at = usable.findIndex((i) => i.id === value)
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
  let next: TabItem<Id> | undefined
  if (step) next = usable[(at + step + usable.length) % usable.length]
  else if (e.key === 'Home') next = usable[0]
  else if (e.key === 'End') next = usable[usable.length - 1]
  if (!next) return
  e.preventDefault()
  pick(next.id)
  const index = items.indexOf(next)
  root?.querySelectorAll<HTMLButtonElement>(':scope > button')[index]?.focus()
}

export function Tabs<Id extends string>({ items, value, onChange, label, className, idPrefix }: {
  items: TabItem<Id>[]
  value: Id
  onChange: (id: Id) => void
  label: string
  className?: string
  /** Gives each tab an id (`${idPrefix}-tab-${id}`) and points it at its panel (`${idPrefix}-panel-${id}`). */
  idPrefix?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className={`k-tabs ${className ?? ''}`} role="tablist" aria-label={label} ref={ref}
      onKeyDown={(e) => moveWith(e, items, value, onChange, ref.current)}>
      {items.map((item) => {
        const selected = item.id === value
        return (
          <button key={item.id} type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1}
            id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined} aria-controls={idPrefix ? `${idPrefix}-panel-${item.id}` : undefined}
            aria-label={item.name} disabled={item.disabled} className={selected ? 'on' : ''} data-testid={item.testId}
            onClick={() => onChange(item.id)}>
            {item.icon}
            <span>{item.label}</span>
            {!!item.count && <span className="k-tab-count">{item.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** The panel under a tab bar that uses `idPrefix`. */
export function TabPanel({ idPrefix, id, children, className }: { idPrefix: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className={className}>
      {children}
    </div>
  )
}

/** One value of a few, inside a form (a radio group that looks like a segmented control). */
export function Segmented<Id extends string>({ items, value, onChange, label, className, wrap }: {
  items: TabItem<Id>[]
  value: Id
  onChange: (id: Id) => void
  label: string
  className?: string
  wrap?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className={`segmented ${wrap ? 'wrap' : ''} ${className ?? ''}`} role="radiogroup" aria-label={label} ref={ref}
      onKeyDown={(e) => moveWith(e, items, value, onChange, ref.current)}>
      {items.map((item) => {
        const on = item.id === value
        return (
          <button key={item.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} aria-label={item.name}
            disabled={item.disabled} className={on ? 'on' : ''} data-testid={item.testId} onClick={() => onChange(item.id)}>
            {item.icon}
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
