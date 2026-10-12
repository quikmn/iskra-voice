// Accessibility helpers: a polite announcer for screen readers, and arrow keys in menus and lists.
import { useEffect, useRef, useState } from 'react'
import './a11y.css'

let region: HTMLElement | null = null
let pending: ReturnType<typeof setTimeout> | null = null

/** Says `text` to screen readers, politely (after what they're reading). The latest call wins. */
export function announce(text: string): void {
  if (typeof document === 'undefined' || !text) return
  if (!region || !region.isConnected) {
    region = document.createElement('div')
    region.className = 'sr-only'
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    region.dataset.testid = 'announcer'
    document.body.appendChild(region)
  }
  const el = region
  if (pending) clearTimeout(pending)
  // Cleared first, then set a moment later, so the same words twice are still read.
  el.textContent = ''
  pending = setTimeout(() => {
    el.textContent = text
    pending = null
  }, 60)
}

/** Announces `text` whenever it changes to something non-empty (status lines that come and go). */
export function useAnnounce(text: string | null | undefined): void {
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (text && text !== last.current) announce(text)
    last.current = text ?? null
  }, [text])
}

/** Puts focus back on whatever had it when this mounted, if focus was lost when it unmounts (popovers). */
export function useReturnFocus(): void {
  // Taken on the first render, so a remount (StrictMode) doesn't pick up the popover's own focus.
  const [before] = useState(() => (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null))
  useEffect(() => {
    return () => {
      // After the popover is gone from the page.
      setTimeout(() => {
        const now = document.activeElement
        if ((now && now !== document.body) || !before?.isConnected) return
        // A toolbar that only shows while its row has focus (message actions) shows again once the row has it.
        before.parentElement?.closest<HTMLElement>('[tabindex]')?.focus({ preventScroll: true })
        before.focus({ preventScroll: true })
      })
    }
  }, [before])
}

/** 'smooth' scrolling, unless the system asks for less motion. */
export const scrollBehavior = (): ScrollBehavior =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

const ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

/** The items arrow keys move between: every enabled, visible menu item in the same popup. */
function itemsAround(from: HTMLElement): HTMLElement[] {
  const scope = from.closest<HTMLElement>('[role="dialog"]') ?? from.closest<HTMLElement>('[role="menu"]')
  if (!scope) return []
  return [...scope.querySelectorAll<HTMLElement>(ITEM)].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null)
}

/** Moves focus in a list of items for an arrow key, Home or End; true when it did. */
export function moveFocus(items: HTMLElement[], current: Element | null, key: string, horizontal = false): boolean {
  if (items.length === 0) return false
  const at = current ? items.indexOf(current as HTMLElement) : -1
  const next = horizontal ? 'ArrowRight' : 'ArrowDown'
  const prev = horizontal ? 'ArrowLeft' : 'ArrowUp'
  let to: number
  if (key === next) to = at < 0 ? 0 : (at + 1) % items.length
  else if (key === prev) to = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length
  else if (key === 'Home') to = 0
  else if (key === 'End') to = items.length - 1
  else return false
  items[to].focus()
  return true
}

function onMenuKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
  const target = e.target as HTMLElement | null
  if (!target?.matches?.(ITEM)) return
  const menu = target.closest('[role="menu"]')
  const horizontal = menu?.getAttribute('aria-orientation') === 'horizontal'
  // Up/down (or left/right in a row of items) and Home/End.
  if (horizontal ? !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) : !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
  if (moveFocus(itemsAround(target), target, e.key, horizontal)) e.preventDefault()
}

let installed = false
/** Arrow keys, Home and End move between the items of any open menu (role="menu"). */
export function installMenuKeys(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('keydown', onMenuKey)
}

/**
 * Arrow keys in a grid of buttons laid out in rows (the emoji picker): left/right by one, up/down to the nearest
 * cell in the row above or below, Home/End to the ends. True when it moved.
 */
export function moveInGrid(cells: HTMLElement[], current: Element | null, key: string): boolean {
  const at = cells.indexOf(current as HTMLElement)
  if (at < 0 || cells.length === 0) return false
  let to = -1
  if (key === 'ArrowRight') to = Math.min(at + 1, cells.length - 1)
  else if (key === 'ArrowLeft') to = Math.max(at - 1, 0)
  else if (key === 'Home') to = 0
  else if (key === 'End') to = cells.length - 1
  else if (key === 'ArrowDown' || key === 'ArrowUp') {
    const here = cells[at].getBoundingClientRect()
    const step = key === 'ArrowDown' ? 1 : -1
    let row: number | null = null
    let best = Infinity
    for (let i = at + step; i >= 0 && i < cells.length; i += step) {
      const r = cells[i].getBoundingClientRect()
      if (Math.abs(r.top - here.top) < 2) continue
      if (row === null) row = r.top
      else if (Math.abs(r.top - row) >= 2) break
      const d = Math.abs(r.left - here.left)
      if (d < best) { best = d; to = i }
    }
  } else return false
  if (to < 0 || to === at) return to === at
  cells[to].focus()
  cells[to].scrollIntoView({ block: 'nearest' })
  return true
}

/** Focuses the first menu item inside `el` (for menus opened from the keyboard). */
export function focusFirstItem(el: HTMLElement | null): void {
  el?.querySelector<HTMLElement>(`${ITEM}:not(:disabled)`)?.focus({ preventScroll: true })
}
