// The Shell's drawers on a phone: back opens and closes them (backNav.ts), sideways swipes move them with the
// finger, and focus goes into an opened drawer and back to where it was when it closes.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { openLayers } from '../layers'
import { setDrawerControl, useBackHint } from './backNav'
import { dragEndsOpen, dragProgress, swipeBlocked, swipeIntent, swipeTarget, type Drag, type Panel } from './navLogic'
import './phone-nav.css'

const PHONE = '(max-width: 760px)'
/** Up to this width the member list is a drawer too. */
const MEMBERS_DRAWER = '(max-width: 1100px)'
const COLUMN = { nav: '.nav-column', members: '.members-column' } as const

/** Wires the drawers of the Shell at `shell`. Returns the drawer being dragged, if any (the Shell shows its scrim). */
export function usePhoneNav(shell: RefObject<HTMLElement | null>, panel: Panel, setPanel: (panel: Panel) => void, members: boolean): Drag['panel'] | null {
  const [dragging, setDragging] = useState<Drag['panel'] | null>(null)
  const live = useRef({ panel, setPanel, members })
  useEffect(() => {
    live.current = { panel, setPanel, members }
  })

  // Back: the channels drawer is there to open while the Shell is showing.
  useEffect(() => setDrawerControl({ panel: () => live.current.panel, openNav: () => live.current.setPanel('nav') }), [])

  // Focus: into a drawer as it opens, back to where it was (or the chat) when it closes.
  const shown = useRef<Panel>(panel)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const was = shown.current
    shown.current = panel
    const root = shell.current
    if (!root || was === panel) return
    const isDrawer = (p: Panel) => (p === 'nav' && matchMedia(PHONE).matches) || (p === 'members' && matchMedia(MEMBERS_DRAWER).matches)
    if (panel !== 'none') {
      if (!isDrawer(panel)) return
      if (was === 'none') opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const column = root.querySelector<HTMLElement>(COLUMN[panel])
      if (column && !column.contains(document.activeElement)) {
        column.tabIndex = -1
        column.focus({ preventScroll: true })
      }
      return
    }
    if (!isDrawer(was)) return
    const back = opener.current
    opener.current = null
    const column = root.querySelector(COLUMN[was as 'nav' | 'members'])
    // Only when focus is still in the closed drawer (or nowhere): a channel picked there moved on already.
    const active = document.activeElement
    if (active && active !== document.body && !column?.contains(active)) return
    const target = back?.isConnected && back !== document.body && !column?.contains(back) ? back : document.getElementById('main-content')
    target?.focus({ preventScroll: true })
  }, [panel, shell])

  // Swipes: sideways moves on a phone's touch screen open and close the drawers, following the finger.
  useEffect(() => {
    const root = shell.current
    if (!root) return
    const phone = matchMedia(PHONE)
    const still = matchMedia('(prefers-reduced-motion: reduce)')
    let start: { x: number; y: number } | null = null
    let drag: (Drag & { column: HTMLElement; width: number }) | null = null
    let progress = 0
    let last = { x: 0, t: 0 }
    let velocity = 0

    const paint = () => {
      if (!drag || still.matches) return
      const shift = drag.panel === 'nav' ? (progress - 1) * 100 : (1 - progress) * 100
      drag.column.style.transform = `translateX(${shift}%)`
      const scrim = root.querySelector<HTMLElement>(':scope > .scrim')
      if (scrim) scrim.style.opacity = String(progress)
    }
    const clear = () => {
      if (!drag) return
      drag.column.style.transform = ''
      drag.column.style.transition = ''
      const scrim = root.querySelector<HTMLElement>(':scope > .scrim')
      if (scrim) scrim.style.opacity = ''
    }
    const onStart = (e: TouchEvent) => {
      start = null
      if (drag || e.touches.length !== 1 || !phone.matches) return
      const { panel } = live.current
      // Only with nothing but the drawer itself open (no sheet, dialog, picker, settings...).
      if (openLayers() > (panel === 'none' ? 0 : 1)) return
      // Selecting text: the handles move sideways.
      const selection = document.getSelection()
      if (selection && !selection.isCollapsed) return
      if (swipeBlocked(e.target instanceof Element ? e.target : null, root)) return
      const touch = e.touches[0]
      start = { x: touch.clientX, y: touch.clientY }
      last = { x: touch.clientX, t: e.timeStamp }
      velocity = 0
    }
    const onMove = (e: TouchEvent) => {
      if (!start) return
      if (e.touches.length !== 1) return onCancel()
      const touch = e.touches[0]
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (!drag) {
        const intent = swipeIntent(dx, dy)
        if (intent === 'pending') return
        const { panel, members } = live.current
        const target = intent === 'horizontal' ? swipeTarget(panel, dx, members) : null
        const column = target && root.querySelector<HTMLElement>(COLUMN[target.panel])
        if (!target || !column) {
          start = null // scrolling, or nothing to move that way
          return
        }
        drag = { ...target, column, width: column.getBoundingClientRect().width }
        column.style.transition = 'none'
        setDragging(target.panel)
      }
      // A sideways drag: the list doesn't scroll and the browser doesn't navigate.
      if (e.cancelable) e.preventDefault()
      const dt = e.timeStamp - last.t
      if (dt > 0) velocity = 0.7 * ((touch.clientX - last.x) / dt) + 0.3 * velocity
      last = { x: touch.clientX, t: e.timeStamp }
      progress = dragProgress(drag, dx, drag.width)
      paint()
    }
    const finish = (open: boolean | null) => {
      const ended = drag
      clear()
      drag = null
      start = null
      setDragging(null)
      if (!ended || open === null) return
      const { panel, setPanel } = live.current
      const next = open ? ended.panel : 'none'
      if (next !== panel) setPanel(next)
    }
    const onEnd = (e: TouchEvent) => {
      if (!drag) {
        start = null
        return
      }
      // A finger that stopped before lifting isn't a flick.
      const stale = e.timeStamp - last.t > 80
      finish(dragEndsOpen(drag, progress, stale ? 0 : velocity))
    }
    const onCancel = () => finish(null)

    root.addEventListener('touchstart', onStart, { passive: true })
    root.addEventListener('touchmove', onMove, { passive: false })
    root.addEventListener('touchend', onEnd)
    root.addEventListener('touchcancel', onCancel)
    return () => {
      root.removeEventListener('touchstart', onStart)
      root.removeEventListener('touchmove', onMove)
      root.removeEventListener('touchend', onEnd)
      root.removeEventListener('touchcancel', onCancel)
      clear()
    }
  }, [shell])

  return dragging
}

/** "Press back again to leave": a short note after back on the channels drawer. */
export function BackHint() {
  const { t } = useTranslation()
  const until = useBackHint((s) => s.until)
  if (!until) return null
  return <div className="back-hint" role="status" aria-live="polite">{t('app.backAgainToLeave')}</div>
}
