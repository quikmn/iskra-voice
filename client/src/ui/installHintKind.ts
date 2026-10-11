// Which "get the app" hint a phone browser should see: iPhone/iPad → add to Home Screen, Android → the Android app.

export type InstallHintKind = 'ios' | 'android'

export interface HintEnv {
  userAgent: string
  maxTouchPoints: number
  /** Running as an installed app (display-mode standalone, or iOS's navigator.standalone). */
  standalone: boolean
  /** document.referrer: the Android app opens Iskra with an android-app:// referrer. */
  referrer: string
  /** Inside the desktop app. */
  desktopApp: boolean
  /** Inside the phone app (mobile/). */
  nativeApp: boolean
  /** Driven by automation (navigator.webdriver): tests and link previews don't get nagged. */
  automated: boolean
}

export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  // iPadOS asks for desktop sites and says "Macintosh"; only real Macs have no touch screen.
  return /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
}

/** The hint to show, or null when Iskra is already an app here (or this isn't a phone or tablet). */
export function installHintKind(env: HintEnv): InstallHintKind | null {
  if (env.desktopApp || env.nativeApp || env.automated || env.standalone || env.referrer.startsWith('android-app://')) return null
  if (isIos(env.userAgent, env.maxTouchPoints)) return 'ios'
  if (/Android/i.test(env.userAgent)) return 'android'
  return null
}

export const HINT_DISMISSED = 'iskra.install-hint-dismissed'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Dismissing is remembered per kind of hint, for good. */
export function hintDismissed(store: Store | null, kind: InstallHintKind): boolean {
  try {
    return (store?.getItem(HINT_DISMISSED) ?? '').split(',').includes(kind)
  } catch {
    return false
  }
}

export function dismissHint(store: Store | null, kind: InstallHintKind): void {
  try {
    if (!store || hintDismissed(store, kind)) return
    const current = store.getItem(HINT_DISMISSED)
    store.setItem(HINT_DISMISSED, current ? `${current},${kind}` : kind)
  } catch {
    /* private mode: the component still hides it for this visit */
  }
}
