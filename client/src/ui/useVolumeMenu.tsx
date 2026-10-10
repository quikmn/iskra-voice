// Right-click (or press and hold) someone in voice to change how loud they are for you.
import { useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { VolumeMenu, type VolumeTarget } from './VolumeMenu'

const HOLD_MS = 450
const SLOP_PX = 10

/**
 * `bind(person)` gives a voice participant's element its context-menu and long-press handlers; `menu` is the
 * popover to render. Pass null for yourself (nothing to adjust).
 */
export function useVolumeMenu() {
  const [target, setTarget] = useState<VolumeTarget | null>(null)
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const fired = useRef(false)

  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }

  const bind = (person: { accountKey: string; name: string } | null) => {
    if (!person) return {}
    return {
      onContextMenu: (e: MouseEvent<HTMLElement>) => {
        e.preventDefault()
        cancel()
        setTarget({ ...person, anchor: e.currentTarget })
      },
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (e.pointerType !== 'touch') return
        fired.current = false
        const anchor = e.currentTarget
        press.current = {
          x: e.clientX,
          y: e.clientY,
          timer: setTimeout(() => {
            fired.current = true
            press.current = null
            navigator.vibrate?.(10)
            setTarget({ ...person, anchor })
          }, HOLD_MS),
        }
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > SLOP_PX) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      // The tap that ends a long press shouldn't also open the profile.
      onClickCapture: (e: MouseEvent<HTMLElement>) => {
        if (!fired.current) return
        fired.current = false
        e.preventDefault()
        e.stopPropagation()
      },
    }
  }

  const menu = target && <VolumeMenu target={target} onClose={() => setTarget(null)} />
  return { bind, menu }
}
