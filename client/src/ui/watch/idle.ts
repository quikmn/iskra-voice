// A player's controls lie over the picture and step aside while it plays and nobody touches it. They always show
// while paused, while a keyboard has focus in them, on touch screens (no hover to bring them back) and while one of
// their menus is open.
import { useEffect, useRef, useState, type RefObject } from 'react'

/** How long after the last pointer move or key the controls stay. */
export const IDLE_MS = 3000
/** After the pointer leaves the picture they go sooner. */
export const LEAVE_MS = 600

export interface ControlsState {
  /** The video is playing (paused: the controls stay). */
  playing: boolean
  /** When the pointer last moved or a key was pressed over the player (ms). */
  lastActive: number
  now: number
  /** Something keeps them up: a menu of theirs is open, the seek bar is being dragged. */
  pinned: boolean
  /** A keyboard has focus on one of the controls. */
  keyboard: boolean
  /** The last pointer was a finger or pen, or the device has no hover. */
  touch: boolean
}

export function controlsVisible(s: ControlsState): boolean {
  if (!s.playing || s.pinned || s.keyboard || s.touch) return true
  return s.now - s.lastActive < IDLE_MS
}

/** How long until they would hide (ms), or null while something keeps them up. */
export function hideIn(s: ControlsState): number | null {
  if (!s.playing || s.pinned || s.keyboard || s.touch) return null
  return Math.max(0, s.lastActive + IDLE_MS - s.now)
}

const noHover = () => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches

function has(frame: HTMLElement, selector: string): boolean {
  try {
    return !!frame.querySelector(selector)
  } catch {
    return false // a browser without :focus-visible: the controls then follow the pointer only
  }
}

/**
 * True while the controls over `frame` should be out of sight. `active` is off when they aren't over the picture at
 * all (nothing to hide).
 */
export function useIdleControls(frame: RefObject<HTMLElement | null>, { active, playing, pinned }: { active: boolean; playing: boolean; pinned: boolean }): boolean {
  const [idle, setIdle] = useState(false)
  const lastActive = useRef(0)
  const touch = useRef(noHover())
  const latest = useRef({ playing, pinned })
  useEffect(() => {
    latest.current = { playing, pinned } // before the effects below, which read it
  })
  const check = useRef<() => void>(() => undefined)

  useEffect(() => {
    const el = frame.current
    if (!active || !el) return
    lastActive.current = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      clearTimeout(timer)
      const state: ControlsState = {
        ...latest.current,
        pinned: latest.current.pinned || has(el, '.watch-controls [aria-expanded="true"]'),
        keyboard: has(el, '.watch-controls :focus-visible'),
        touch: touch.current,
        lastActive: lastActive.current,
        now: Date.now(),
      }
      setIdle(!controlsVisible(state))
      const wait = hideIn(state)
      // Pinned by an open menu: look again later (it closes without telling us).
      if (wait !== null ? wait > 0 : state.playing && !state.touch) timer = setTimeout(update, wait ?? IDLE_MS)
    }
    check.current = update
    const stir = (e: Event) => {
      if (e instanceof PointerEvent) touch.current = e.pointerType !== 'mouse' || noHover()
      lastActive.current = Date.now()
      update()
    }
    const leave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      lastActive.current = Math.min(lastActive.current, Date.now() - IDLE_MS + LEAVE_MS)
      update()
    }
    const events = ['pointermove', 'pointerdown', 'keydown', 'focusin', 'focusout'] as const
    for (const name of events) el.addEventListener(name, stir)
    el.addEventListener('pointerleave', leave)
    update()
    return () => {
      clearTimeout(timer)
      for (const name of events) el.removeEventListener(name, stir)
      el.removeEventListener('pointerleave', leave)
    }
  }, [frame, active])

  // Play, pause, a drag that ended: work it out again (pressing play counts as touching the player).
  useEffect(() => {
    lastActive.current = Date.now()
    check.current()
  }, [playing, pinned])

  return active && idle
}
