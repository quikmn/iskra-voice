// Several accounts in one app, as one account's page sees it: the switcher's list, adding and switching accounts,
// telling the host page (state/accountHost.ts) this account's name, unread count and voice, and the one-microphone rule.
// With one account on the device there is no host: adding a second one restarts the page as the host of both.
import { create } from 'zustand'
import { t } from '../i18n'
import { loadLanguageChoice, setLanguageChoice } from '../i18n'
import { b64u } from '../core/crypto'
import { applySavedTheme } from '../theme/theme'
import { accountLink, bootSlot, rawLocalStorage } from '../platform/accountBoot'
import { ACCOUNT_INPUT_EVENT, emptySummary, type AccountSummary, type AccountView } from '../platform/accountLink'
import {
  addAccount, MAX_ACCOUNTS, MAX_ACCOUNTS_PHONE, parseRegistry, REGISTRY_KEY, seedSettings, serializeRegistry, singleRegistry, updateEntry, type AddMode,
} from '../platform/accountSlots'
import { native } from '../platform/native'
import { setAccountLabel } from './accountFocus'
import { useCalls } from './calls'
import { nameOf } from './dms'
import { useGroupCalls } from './groupCalls'
import { useOrganize } from './organize'
import { useReads } from './readState'
import { useApp } from './store'
import { useThreads } from './threads'
import { badgeTotal } from './unread'
import { leaveVoiceForAccount, setVoiceGate, useVoice } from './voice'

interface AccountsState {
  /** Every account on this device, in the switcher's order (just this one without a host). */
  accounts: AccountView[]
  /** A short note for a few seconds ("Left voice as Ada"). */
  toast: string | null
}

export const useAccounts = create<AccountsState>(() => ({ accounts: [], toast: null }))

/** This page's account slot. */
export const thisSlot = bootSlot
/** How many accounts this device keeps signed in. */
export const maxAccounts = accountLink?.max ?? (native ? MAX_ACCOUNTS_PHONE : MAX_ACCOUNTS)
/** This page runs next to other accounts' pages (in the host). */
export const inHost = !!accountLink

/** What this account tells the host about itself. Nothing secret: its name, public key, picture and counts. */
export function currentSummary(): AccountSummary {
  const { phase, profile, identity } = useApp.getState()
  const call = useCalls.getState().call
  const ring = useGroupCalls.getState().ringing
  return {
    ...emptySummary(),
    name: profile?.name ?? '',
    key: identity ? b64u(identity.account.publicKey) : null,
    avatar: profile?.avatar ? { bytes: profile.avatar.bytes, type: profile.avatar.type, hash: profile.avatar.hash } : null,
    unread: phase === 'ready' ? badgeTotal() : 0,
    inVoice: !!useVoice.getState().session,
    locked: phase === 'locked',
    ready: phase === 'ready',
    ringing: call?.phase === 'incoming' ? nameOf(call.peer) : ring ? nameOf(ring.from) : null,
    title: typeof document === 'undefined' ? 'Iskra' : document.title,
  }
}

const same = (a: AccountSummary, b: AccountSummary) =>
  a.name === b.name && a.key === b.key && a.avatar?.hash === b.avatar?.hash && a.unread === b.unread && a.inVoice === b.inVoice
  && a.locked === b.locked && a.ready === b.ready && a.ringing === b.ringing && a.title === b.title

/** The switcher's list without a host: this account alone. */
const soloView = (summary: AccountSummary): AccountView => ({ ...summary, slot: bootSlot, adding: null, active: true, duplicateOf: null })

/** This account's entry in the list. */
export const myView = (): AccountView | undefined => useAccounts.getState().accounts.find((a) => a.slot === thisSlot)

/** The name to show for an account (a new one has none until it's set up). */
export const accountName = (account: Pick<AccountView, 'name'>): string => account.name || t('accounts.switcher.unnamed')

let toastTimer: ReturnType<typeof setTimeout> | undefined
export function showAccountToast(text: string): void {
  clearTimeout(toastTimer)
  useAccounts.setState({ toast: text })
  toastTimer = setTimeout(() => useAccounts.setState({ toast: null }), 6000)
}

export const dismissAccountToast = () => useAccounts.setState({ toast: null })

// ── Actions ─────────────────────────────────────────────────────────────

/** Adds an account. Without a host, this page restarts as the host of both (Iskra keeps the new one on screen). */
export function addAccountHere(mode: AddMode): void {
  if (accountLink) return accountLink.add(mode)
  const raw = rawLocalStorage
  if (!raw) return
  const stored = raw.getItem(REGISTRY_KEY)
  let registry = stored ? parseRegistry(stored) : singleRegistry(bootSlot)
  const me = currentSummary()
  registry = updateEntry(registry, bootSlot, { name: me.name || undefined, key: me.key ?? undefined })
  const added = addAccount(registry, mode, maxAccounts)
  if (!added) return
  seedSettings(raw, bootSlot, added.slot)
  raw.setItem(REGISTRY_KEY, serializeRegistry(added.registry))
  window.location.reload()
}

export const switchAccount = (slot: number) => accountLink?.switchTo(slot)
export const moveAccountInList = (slot: number, delta: -1 | 1) => accountLink?.move(slot, delta)
/** How this account is being added (its first-run screen opens there), while it isn't signed in yet. */
export const addingMode = (): AddMode | null => accountLink?.adding() ?? null
export const cancelAdding = () => accountLink?.cancelAdd()

/**
 * Called once this account forgot everything it kept here (signed out). True if the host takes it from here (the
 * page then must not restart by itself).
 */
export function accountSignedOut(): boolean {
  if (!accountLink) return false
  accountLink.signedOut()
  return true
}

// ── Keeping the host up to date ─────────────────────────────────────────

/** How often input on this page is passed on to the other accounts' pages (idle is minutes). */
const INPUT_EVERY_MS = 20_000

/** The language and theme belong to the device: when another account's page changes them, follow. */
function onStorage(event: StorageEvent): void {
  if (event.key === 'iskra.theme') applySavedTheme()
  if (event.key === 'iskra.language') setLanguageChoice(loadLanguageChoice())
}

/** Starts reporting to the host and listening to it; returns a function that stops. */
export function startAccounts(): () => void {
  let last = currentSummary()
  const update = () => {
    const next = currentSummary()
    if (!accountLink) {
      useAccounts.setState({ accounts: [soloView(next)] })
      return
    }
    if (same(next, last)) return
    last = next
    accountLink.report(next)
  }
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      update()
    })
  }
  const stops = [useApp, useVoice, useCalls, useGroupCalls, useReads, useOrganize, useThreads].map((store) => (store as { subscribe(l: () => void): () => void }).subscribe(schedule))

  // The page title (notify.ts keeps "(3) Iskra" there; settings names its page): the host shows the one on screen.
  const title = typeof document !== 'undefined' ? document.querySelector('title') : null
  const titleWatch = title ? new MutationObserver(schedule) : null
  titleWatch?.observe(title!, { childList: true, characterData: true, subtree: true })

  if (accountLink) {
    accountLink.report(last)
    const link = accountLink
    const onList = (accounts: AccountView[]) => {
      useAccounts.setState({ accounts })
      const mine = accounts.find((a) => a.slot === thisSlot)
      setAccountLabel(accounts.length > 1 && mine ? accountName(mine) : null)
    }
    onList(link.accounts())
    stops.push(link.onAccounts(onList))
    // One device, one microphone: joining voice here makes any other account here leave voice first.
    setVoiceGate(() => {
      const left = link.claimVoice()
      if (left) showAccountToast(t('accounts.voice.leftAs', { name: left }))
    })
    stops.push(link.onLeaveVoice((joinedAs) => void leaveVoiceForAccount(joinedAs)))
    window.addEventListener('storage', onStorage)
    stops.push(() => window.removeEventListener('storage', onStorage))
    // The person is at the device: input on any account's page keeps every account here from going idle.
    let lastInput = 0
    const used = () => {
      const now = Date.now()
      if (now - lastInput < INPUT_EVERY_MS) return
      lastInput = now
      link.input()
    }
    const inputs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
    for (const e of inputs) window.addEventListener(e, used, { passive: true })
    stops.push(() => inputs.forEach((e) => window.removeEventListener(e, used)))
    stops.push(link.onInput(() => window.dispatchEvent(new Event(ACCOUNT_INPUT_EVENT))))
  } else {
    update()
  }
  return () => {
    for (const stop of stops) stop()
    titleWatch?.disconnect()
    setVoiceGate(() => {})
  }
}
