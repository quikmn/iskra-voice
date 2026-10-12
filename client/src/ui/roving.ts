// Roving tabindex for long lists of buttons (the server rail, the channel list): the list is one Tab stop, arrow keys
// move inside it. Done on the DOM after each render, so the rows themselves stay plain buttons.
import { useEffect, useRef, type RefObject } from 'react'

export interface RovingOptions {
  /** The items arrow keys move between. */
  items: string
  /** The item that's the Tab stop until one has had focus (the open server or channel). */
  current?: string
  /** A row around an item: its other buttons (⋯, +) stay in the Tab order only for the row that has the Tab stop. */
  row?: string
  /** Other keys (left/right in a tree); true when handled. */
  onKey?: (e: KeyboardEvent, item: HTMLElement, items: HTMLElement[]) => boolean
}

const usable = (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0

/** Which item gets the Tab stop: the last one focused while it's still there, else `current`, else the first. */
export function pickStop(items: HTMLElement[], last: HTMLElement | null, current: HTMLElement | null): HTMLElement | null {
  const ok = items.filter(usable)
  if (last && ok.includes(last)) return last
  if (current && ok.includes(current)) return current
  return ok[0] ?? null
}

/** Where Up/Down/Home/End go in a list (no wrapping, like a tree); -1 for other keys. */
export function stepIndex(length: number, at: number, key: string): number {
  if (length === 0) return -1
  if (key === 'ArrowDown') return Math.min(length - 1, at + 1)
  if (key === 'ArrowUp') return Math.max(0, at - 1)
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  return -1
}

export function useRoving(ref: RefObject<HTMLElement | null>, options: RovingOptions): void {
  const opts = useRef(options)
  const last = useRef<HTMLElement | null>(null)
  const sync = useRef(() => {})
  useEffect(() => {
    opts.current = options
  })

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const all = () => [...root.querySelectorAll<HTMLElement>(opts.current.items)]
    sync.current = () => {
      const items = all()
      const { current, row } = opts.current
      const stop = pickStop(items, last.current, current ? root.querySelector<HTMLElement>(current) : null)
      for (const el of items) {
        const index = el === stop ? 0 : -1
        if (el.tabIndex !== index) el.tabIndex = index
      }
      if (!row) return
      for (const r of root.querySelectorAll<HTMLElement>(row)) {
        const index = stop && r.contains(stop) ? 0 : -1
        for (const b of r.querySelectorAll<HTMLElement>('button')) {
          if (!b.matches(opts.current.items) && b.tabIndex !== index) b.tabIndex = index
        }
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const item = e.target as HTMLElement
      if (!item.matches?.(opts.current.items)) return
      const items = all().filter(usable)
      if (opts.current.onKey?.(e, item, items)) {
        e.preventDefault()
        return
      }
      const to = stepIndex(items.length, items.indexOf(item), e.key)
      if (to < 0 || e.shiftKey) return
      e.preventDefault()
      items[to].focus()
      items[to].scrollIntoView?.({ block: 'nearest' })
    }
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement
      if (el.matches?.(opts.current.items) && last.current !== el) {
        last.current = el
        sync.current()
      }
    }
    // Rows re-render on their own (unread counts, voice), and new ones can appear without this list re-rendering.
    const observer = new MutationObserver(() => sync.current())
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-expanded'] })
    root.addEventListener('keydown', onKey)
    root.addEventListener('focusin', onFocus)
    sync.current()
    return () => {
      observer.disconnect()
      root.removeEventListener('keydown', onKey)
      root.removeEventListener('focusin', onFocus)
    }
  }, [ref])

  useEffect(() => sync.current())
}

/**
 * Left/right in a tree of groups (categories, folders): left closes an open group or goes up to its head, right opens a
 * closed one or goes to its first item. `group` is the element around a head and its items.
 */
export function treeKeys(group: string, head: string): NonNullable<RovingOptions['onKey']> {
  return (e, item, items) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false
    const isHead = item.matches(head)
    const box = item.closest<HTMLElement>(group)
    if (!box) return false
    const open = isHead && item.getAttribute('aria-expanded') === 'true'
    if (e.key === 'ArrowLeft') {
      if (open) item.click()
      else if (!isHead) box.querySelector<HTMLElement>(head)?.focus()
      else return false
      return true
    }
    if (!isHead) return false
    if (!open) {
      item.click()
      return true
    }
    const next = items[items.indexOf(item) + 1]
    if (next && box.contains(next)) next.focus()
    return true
  }
}

/** The context-menu key or Shift+F10: opens an item's menu from the keyboard. */
export const isMenuKey = (e: { key: string; shiftKey: boolean }) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')
