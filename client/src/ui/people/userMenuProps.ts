// Spread onto anything that stands for a person: right-click opens their menu; on touch screens, press and hold.
import type { MouseEvent, PointerEvent } from 'react'
import { openUserMenu } from '../../state/userMenu'

const HOLD_MS = 450
const SLOP_PX = 10

// One finger, one press at a time: module state keeps this usable inside lists without hooks.
let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null
let fired = false

const cancel = () => {
  if (press) clearTimeout(press.timer)
  press = null
}

export function userMenuProps(accountKey: string | null | undefined, serverKey: string | null = null) {
  if (!accountKey) return {}
  return {
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault()
      e.stopPropagation()
      cancel()
      // A keyboard's context-menu key reports 0,0: open as a sheet instead of in the corner.
      const anchor = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null
      openUserMenu({ accountKey, serverKey, anchor })
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'touch') return
      e.stopPropagation() // the message's own press-and-hold stays out of it
      fired = false
      cancel()
      press = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          fired = true
          press = null
          navigator.vibrate?.(10)
          openUserMenu({ accountKey, serverKey, anchor: null })
        }, HOLD_MS),
      }
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP_PX) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // The tap that ends a long press shouldn't also open the profile.
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (!fired) return
      fired = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
