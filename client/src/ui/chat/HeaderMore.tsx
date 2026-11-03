// Every conversation header follows one overflow rule: a few tools stay as icons, the rest live in a "⋯" menu. How
// many fit depends on the header's own width (a side panel narrows it on desktop too), not on the window's.
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { MenuGroup, MenuItem, OrgMenu, type MenuAnchor } from '../organize/OrgMenu'
import { MoreHorizontal } from '../icons'

/** How much room a header has: `wide` fits the search box, `mid` a few icons, `narrow` (phones) the fewest. */
export type HeaderFit = 'wide' | 'mid' | 'narrow'

export function fitFor(width: number): HeaderFit {
  // Not measured yet (or no layout, as in tests): the roomy layout.
  if (width === 0 || width >= 620) return 'wide'
  return width >= 440 ? 'mid' : 'narrow'
}

/** The element's width, kept up to date as it changes. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(Math.round(el.getBoundingClientRect().width))
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width + 0.5)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

export function useHeaderFit<T extends HTMLElement>(): [RefObject<T | null>, HeaderFit] {
  const [ref, width] = useWidth<T>()
  return [ref, fitFor(width)]
}

export interface MoreItem {
  key: string
  label: string
  icon: ReactNode
  onSelect: () => void
  /** On/off rows show a check at the end while on. */
  on?: boolean
  danger?: boolean
  testId?: string
}

/** The "⋯" at the end of a header. Nothing to put in it: no button. Items come in groups, set apart by a line. */
export function HeaderMore({ label, groups }: { label: string; groups: MoreItem[][] }) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [open, setOpen] = useState(false)
  const shown = groups.filter((g) => g.length > 0)
  if (shown.length === 0) return null
  const close = () => setOpen(false)
  return (
    <>
      <button
        className={`icon-button header-more ${open ? 'on' : ''}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          // From the keyboard on a phone-sized screen the menu is a sheet either way.
          setAnchor({ x: r.right, y: r.bottom + 6 })
          setOpen((o) => !o)
        }}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="header-more"
      >
        <MoreHorizontal />
      </button>
      {open && (
        <OrgMenu anchor={anchor} label={label} onClose={close}>
          <div className="org-list" role="menu" aria-label={label}>
            {shown.map((group, i) => (
              <MenuGroup key={i}>
                {group.map((item) => (
                  <MenuItem key={item.key} icon={item.icon} danger={item.danger} testId={item.testId}
                    toggle={item.on === undefined ? undefined : item.on}
                    onClick={() => {
                      close()
                      item.onSelect()
                    }}>
                    {item.label}
                  </MenuItem>
                ))}
              </MenuGroup>
            ))}
          </div>
        </OrgMenu>
      )}
    </>
  )
}
