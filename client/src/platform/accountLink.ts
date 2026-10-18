// Several accounts in one app: with more than one account signed in, the top page ("the host", state/accountHost.ts)
// holds one same-origin frame per account, each running the whole app for that account alone. This is how an
// account's page and the host talk. The host also stands between each page and the desktop and phone shells, so a
// shell event (a hotkey, an opened link) reaches the right account (state/accountBridges.ts).
import type { AddMode } from './accountSlots'
import type { DesktopBridge } from './desktop'
import type { NativeBridge } from './native'

/** What an account's page tells the host about itself (for the switcher, the badge and the title). Nothing secret. */
export interface AccountSummary {
  name: string
  /** Its account public key (b64u), once signed in. */
  key: string | null
  /** Its profile picture, if it has one. */
  avatar: { bytes: ArrayBuffer; type: string; hash: string } | null
  /** Unread mentions and DMs (what the badge counts). */
  unread: number
  inVoice: boolean
  /** Waiting for its app lock. */
  locked: boolean
  /** Signed in and set up (not on the first-run screen). */
  ready: boolean
  /** Who is calling it right now, if anyone. */
  ringing: string | null
  /** Its page title ("(2) Iskra", "My settings — Iskra"). */
  title: string
}

export const emptySummary = (): AccountSummary => ({
  name: '', key: null, avatar: null, unread: 0, inVoice: false, locked: false, ready: false, ringing: null, title: 'Iskra',
})

/** One account in the switcher. */
export interface AccountView extends AccountSummary {
  slot: number
  /** Being added, not signed in yet. */
  adding: AddMode | null
  /** On screen now. */
  active: boolean
  /** The same account is already signed in here in this other slot (it was added twice). */
  duplicateOf: number | null
}

export type BackResult = 'handled' | 'exit'

export interface AccountLink {
  slot: number
  /** How many accounts this device may have. */
  max: number
  /** The desktop shell, as this account sees it (undefined in a browser). */
  desktop?: DesktopBridge
  /** The phone shell, as this account sees it (undefined elsewhere). */
  native?: NativeBridge
  /** How this account is being added, until it's signed in (its first-run screen opens there). */
  adding(): AddMode | null
  accounts(): AccountView[]
  onAccounts(listener: (accounts: AccountView[]) => void): () => void
  report(summary: Partial<AccountSummary>): void
  switchTo(slot: number): void
  /** Brings this account on screen (a click on one of its notifications). */
  activate(): void
  add(mode: AddMode): void
  /** This account was being added and the person changed their mind: forget it and go back. */
  cancelAdd(): void
  /** This account signed out and forgot everything on this device: take it off the list. */
  signedOut(): void
  move(slot: number, delta: -1 | 1): void
  /** This account is joining voice: any other account here leaves it first. The name of that account, if one did. */
  claimVoice(): string | null
  /** Another account here joined voice (its name): leave. */
  onLeaveVoice(listener: (joinedAs: string) => void): () => void
  /** The browser's back button, when this account is on screen (web only; the phone's back button comes through `native`). */
  setBack(handler: (() => BackResult) | null): void
  /** The person used this account's page (a key, a click): they're at the device, so no account here goes idle. */
  input(): void
  onInput(listener: () => void): () => void
}

/** Dispatched on an account page's window when the person used another account's page (state/presence.ts, state/afk.ts). */
export const ACCOUNT_INPUT_EVENT = 'iskra-input'

/** What the host puts on its window for its frames (`window.parent.__iskraHost`). */
export interface HostApi {
  version: 1
  /** The link for the frame `win` showing account `slot`; null if that isn't the frame the host made for it. */
  link(slot: number, win: Window): AccountLink | null
}
