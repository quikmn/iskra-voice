// The back button, one way everywhere: Android's back (button or edge gesture) in the phone app, and the browser's
// back in the web app. Back closes the top layer (Escape's stack in layers.ts); with nothing open on a phone it shows
// the channels drawer, and on the drawer it goes back to the channel; a second back within two seconds leaves.
import { create } from 'zustand'
import { native } from '../../platform/native'
import { accountLink } from '../../platform/accountBoot'
import { topLayer } from '../layers'
import { backAction, EXIT_WINDOW_MS, type BackAction } from './navLogic'

/** The Shell's drawers, while a phone-width Shell is showing. */
export interface DrawerControl {
  panel: () => 'none' | 'nav' | 'members'
  openNav: () => void
}

let drawer: DrawerControl | null = null
/** The Shell registers its drawers; the returned function unregisters them. */
export function setDrawerControl(control: DrawerControl): () => void {
  drawer = control
  return () => {
    if (drawer === control) drawer = null
  }
}

const PHONE = '(max-width: 760px)'
const phoneWidth = () => typeof window !== 'undefined' && window.matchMedia(PHONE).matches

/** "Press back again to leave": showing until the time it expires. */
export const useBackHint = create<{ until: number }>(() => ({ until: 0 }))
let hintTimer: ReturnType<typeof setTimeout> | null = null

function arm(): void {
  const until = Date.now() + EXIT_WINDOW_MS
  useBackHint.setState({ until })
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => useBackHint.setState({ until: 0 }), EXIT_WINDOW_MS)
}

function disarm(): void {
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = null
  if (useBackHint.getState().until) useBackHint.setState({ until: 0 })
}

/** One press of back; returns what it did ('exit': the caller leaves the app or the page). */
export function pressBack(): BackAction {
  const top = topLayer()
  const action = backAction({
    top: !top ? 'none' : top.kind === 'nav' ? 'nav' : 'layer',
    drawer: !!drawer && phoneWidth(),
    armed: useBackHint.getState().until > Date.now(),
  })
  switch (action) {
    case 'close-layer':
      top!.back()
      break
    case 'open-nav':
      drawer!.openNav()
      break
    case 'close-nav':
      top!.back()
      arm()
      break
    case 'arm':
      arm()
      break
    case 'exit':
      disarm()
      break
  }
  return action
}

// ── The phone app: Capacitor's back button ──

function leaveApp(): void {
  const hook = import.meta.env.DEV ? (window as unknown as { __iskraExitHook?: () => void }).__iskraExitHook : undefined
  if (hook) return hook()
  native?.leave()
}

// ── The web app: one sentinel history entry ──
// The page keeps one extra entry ("guard") on top of where it loaded. Back pops it: the app does what back means, then
// puts the guard back. To leave, it doesn't put it back and steps back once more. Only ever one guard, so the
// history never fills up and two quick backs always leave.

const GUARD = 'iskraNav'
const onGuard = () => (history.state as Record<string, unknown> | null)?.[GUARD] === true

function ensureGuard(): void {
  if (!onGuard()) history.pushState({ [GUARD]: true }, '')
}

/** Leaving: stepping back past this page's own entries, until the browser leaves it. */
let leavingUntil = 0

function leavePage(): void {
  leavingUntil = Date.now() + 1000
  history.back()
}

function onPopState(): void {
  if (Date.now() < leavingUntil) return leavePage()
  // A route in the address bar ("#/open/…", "#/join/…") is a navigation, not back; its reader handles it.
  if (/^#\/(open|join|link)\//.test(location.hash)) return
  // Wide windows have no drawer: with nothing open, back just leaves, as on any page.
  const wide = !drawer || !phoneWidth()
  if ((wide && !topLayer()) || pressBack() === 'exit') return leavePage()
  // Landing on the guard means an entry above it (a link that was opened) was popped: it's still in place.
  ensureGuard()
}

let installed = false
/** Wires the back button once, at startup. */
export function installBackNav(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  if (import.meta.env.DEV) {
    // Tests: the phone app's back button (Capacitor's backButton event), without the phone.
    ;(window as unknown as { __iskraNativeBack?: () => void }).__iskraNativeBack = () => {
      if (pressBack() === 'exit') leaveApp()
    }
  }
  if (accountLink && !native) {
    // Next to other accounts on this device the host page keeps the history entry and asks the account on screen.
    accountLink.setBack(() => {
      const wide = !drawer || !phoneWidth()
      return (wide && !topLayer()) || pressBack() === 'exit' ? 'exit' : 'handled'
    })
    return
  }
  if (native) {
    // A listener replaces Capacitor's default (go back in the web view, or quit).
    native.onBackButton(() => {
      if (pressBack() === 'exit') leaveApp()
    })
    return
  }
  ensureGuard()
  // Browsers skip entries added before the person touched the page; a tap makes it count.
  window.addEventListener('pointerdown', ensureGuard, { capture: true, passive: true })
  window.addEventListener('popstate', onPopState)
}
