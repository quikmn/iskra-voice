// Touch: press and hold to open a message's actions. Moving (scrolling) cancels; mice and pens are left alone.
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

const HOLD_MS = 450
const SLOP_PX = 10

export function useLongPress(onLongPress: () => void, enabled = true) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    start.current = null
  }

  if (!enabled) return {}
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType !== 'touch') return
      // Links, buttons and fields keep their own tap behaviour.
      if ((e.target as Element).closest('a, button, input, textarea, video, audio, [role=button], .poll')) return
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        fired.current = true
        timer.current = null
        navigator.vibrate?.(10)
        onLongPress()
      }, HOLD_MS)
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP_PX) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // The browser's own long-press menu (and text selection callout) would fight ours.
    onContextMenu: (e: React.MouseEvent) => {
      if (fired.current || timer.current) e.preventDefault()
    },
  }
}
