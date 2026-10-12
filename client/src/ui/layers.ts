// Escape closes only the top layer (modal, popover, sheet), however many are open.
import { useEffect, useRef, useState, type RefObject } from 'react'

const stack: { close: () => void }[] = []

function onKey(e: KeyboardEvent) {
  // Something inside already handled it (an inline editor, a reply being cancelled).
  if (e.key !== 'Escape' || e.defaultPrevented) return
  const top = stack.at(-1)
  if (!top) return
  e.preventDefault()
  top.close()
}

/** Registers a layer while mounted (and `active`); Escape calls onClose only when it's the top one. */
export function useEscapeLayer(onClose: () => void, active = true): void {
  const latest = useRef(onClose)
  useEffect(() => {
    latest.current = onClose
  })
  useEffect(() => {
    if (!active) return
    const layer = { close: () => latest.current() }
    stack.push(layer)
    if (stack.length === 1) window.addEventListener('keydown', onKey)
    return () => {
      const i = stack.indexOf(layer)
      if (i >= 0) stack.splice(i, 1)
      if (stack.length === 0) window.removeEventListener('keydown', onKey)
    }
  }, [active])
}

/** How many layers are open (for tests and global shortcuts that shouldn't fire under a dialog). */
export const openLayers = () => stack.length

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Keeps Tab inside a dialog and puts focus back where it was when the dialog closes. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>) {
  // Who had focus when this first rendered: before a field in it autofocuses, and kept across StrictMode remounts.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const before = opener && !el.contains(opener) ? opener : null
    // Prefer a field marked data-autofocus or the first field in the body; the dialog itself otherwise (never the close button).
    // Touch screens get the dialog itself, so the keyboard doesn't pop up uninvited.
    if (!el.contains(document.activeElement)) {
      const touch = window.matchMedia('(pointer: coarse)').matches
      const first = touch ? null : el.querySelector<HTMLElement>('[data-autofocus], .modal-body :is(input, textarea):not(:disabled):not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=range]):not([type=color])')
      ;(first ?? el).focus({ preventScroll: true })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [ref, opener])
}
