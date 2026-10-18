// The host page: with several accounts signed in, the top page holds one same-origin frame per account (each the whole
// app for that account alone; platform/accountBoot.ts) and only does what concerns all of them:
// - the list of accounts (platform/accountSlots.ts): adding, switching, reordering, taking one off after it signed out;
// - the taskbar badge and the window title (every account's unread added up);
// - one account in voice at a time (one device, one microphone);
// - links opened from outside (invites, device links, notification clicks, iskra:// and the phone's links): to the
//   account they name, else the person picks one;
// - the desktop and phone shells, lent to each frame so their events reach the right account (state/accountBridges.ts).
// It never reads or keeps any account's data: frames report a summary (name, public key, picture, counts).
import { create } from 'zustand'
import { emptySummary, type AccountLink, type AccountSummary, type AccountView, type BackResult, type HostApi } from '../platform/accountLink'
import { rawLocalStorage, rawSessionStorage } from '../platform/accountBoot'
import {
  addAccount, MAX_ACCOUNTS, MAX_ACCOUNTS_PHONE, moveAccount, parseRegistry, REGISTRY_KEY, removeAccount, seedSettings, serializeRegistry, setActive,
  updateEntry, wipeSlot, type AddMode, type Registry,
} from '../platform/accountSlots'
import { overlayIcon } from '../platform/badge'
import { hostDesktop as shellDesktop } from '../platform/desktop'
import { hostNative as shellNative } from '../platform/native'
import { slotOfScope } from '../core/pushRoute'
import { createBridges, type Bridges } from './accountBridges'

/** A link opened from outside, waiting for an account: an app route ("#/join/…"), an iskra:// token, or a phone URL. */
export type IncomingLink = { kind: 'hash'; route: string } | { kind: 'token' | 'url'; value: string }

interface HostState {
  registry: Registry
  summaries: Record<number, AccountSummary>
  /** A link waiting for the person to pick an account. */
  choosing: IncomingLink | null
  /** A device link ("#/link/…") from outside, waiting for the person to say it's theirs (it would add an account). */
  linking: string | null
}

export const useHost = create<HostState>(() => ({ registry: parseRegistry(null), summaries: {}, choosing: null, linking: null }))

export const hostMax = shellNative ? MAX_ACCOUNTS_PHONE : MAX_ACCOUNTS

interface FrameState {
  element: HTMLIFrameElement | null
  link: AccountLink | null
  win: Window | null
  listeners: Set<(accounts: AccountView[]) => void>
  leaveVoice: Set<(joinedAs: string) => void>
  input: Set<() => void>
  back: (() => BackResult) | null
  /** An app route to hand over once the frame's page is up. */
  pendingRoute: string | null
}

const frames = new Map<number, FrameState>()
const frame = (slot: number): FrameState => {
  let f = frames.get(slot)
  if (!f) frames.set(slot, (f = { element: null, link: null, win: null, listeners: new Set(), leaveVoice: new Set(), input: new Set(), back: null, pendingRoute: null }))
  return f
}

/** Where to go back to when an account being added is given up. */
const returnTo = new Map<number, number>()
/** Accounts added a second time (signed in as an account already here): slot → the slot that had it first. */
const duplicates = new Map<number, number>()
let voiceSlot: number | null = null

const registry = () => useHost.getState().registry

function save(next: Registry): void {
  useHost.setState({ registry: next })
  try {
    rawLocalStorage?.setItem(REGISTRY_KEY, serializeRegistry(next))
  } catch {
    /* storage blocked: the list lasts until the page closes */
  }
  broadcast()
}

const summaryOf = (slot: number): AccountSummary => useHost.getState().summaries[slot] ?? emptySummary()

/** The switcher's list, as every account's page gets it. */
export function views(): AccountView[] {
  const reg = registry()
  return reg.order.map((slot) => {
    const summary = summaryOf(slot)
    const entry = reg.accounts[slot]
    return {
      ...summary,
      name: summary.name || entry?.name || '',
      key: summary.key ?? entry?.key ?? null,
      slot,
      adding: entry?.adding ?? null,
      active: slot === reg.active,
      duplicateOf: duplicates.get(slot) ?? null,
    }
  })
}

function broadcast(): void {
  const list = views()
  for (const f of frames.values()) {
    for (const listener of [...f.listeners]) {
      try {
        listener(list)
      } catch (e) {
        console.warn('[iskra] account list listener failed', e)
      }
    }
  }
  showTotals()
}

// ── The badge and the title ─────────────────────────────────────────────

let lastBadge = -1
function showTotals(): void {
  const reg = registry()
  const total = reg.order.reduce((n, slot) => n + summaryOf(slot).unread, 0)
  const own = summaryOf(reg.active).title.replace(/^\(\d+\) /, '') || 'Iskra'
  document.title = total > 0 ? `(${total}) ${own}` : own
  if (shellDesktop?.setBadge && total !== lastBadge) {
    lastBadge = total
    void shellDesktop.setBadge(total, overlayIcon(total)).catch(() => undefined)
  }
}

// ── Switching ───────────────────────────────────────────────────────────

let bridges: Bridges | null = null

export function switchTo(slot: number): void {
  const reg = registry()
  if (!reg.order.includes(slot)) return
  if (reg.active !== slot) save(setActive(reg, slot))
  bridges?.ownerChanged()
  focusFrame(slot)
}

function focusFrame(slot: number): void {
  // After React shows it.
  requestAnimationFrame(() => {
    try {
      frames.get(slot)?.element?.contentWindow?.focus()
    } catch {
      /* not loaded yet */
    }
  })
}

export function addAccountSlot(mode: AddMode): number | null {
  const reg = registry()
  const added = addAccount(reg, mode, hostMax)
  if (!added) return null
  if (rawLocalStorage) seedSettings(rawLocalStorage, reg.active, added.slot)
  returnTo.set(added.slot, reg.active)
  save(added.registry)
  bridges?.ownerChanged()
  return added.slot
}

/** Takes an account off this device: its page forgot everything (signed out), or it was given up while being added. */
async function removeSlot(slot: number, fallback?: number): Promise<void> {
  frames.delete(slot)
  bridges?.drop(slot)
  if (voiceSlot === slot) voiceSlot = null
  returnTo.delete(slot)
  duplicates.delete(slot)
  for (const [dup, first] of duplicates) if (first === slot) duplicates.delete(dup)
  useHost.setState((s) => {
    const summaries = { ...s.summaries }
    delete summaries[slot]
    return { summaries }
  })
  const next = removeAccount(registry(), slot, fallback)
  if (next.order.length) {
    // Its frame goes with the list; then whatever it left behind goes too.
    save(next)
    switchTo(next.active)
  }
  // Its storage, and its push registrations (which belong to this account alone).
  await wipeSlot(slot, { local: rawLocalStorage, session: rawSessionStorage, idb: typeof indexedDB === 'undefined' ? null : indexedDB })
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? []
    for (const reg of regs) if (slotOfScope(reg.scope) === slot) void reg.unregister().catch(() => undefined)
  } catch {
    /* no service workers here */
  }
  if (!next.order.length) {
    // The last account signed out: start fresh, as a device with no account.
    try {
      rawLocalStorage?.removeItem(REGISTRY_KEY)
    } catch {
      /* blocked */
    }
    window.location.reload()
  }
}

// ── Voice: one account at a time ────────────────────────────────────────

function claimVoice(slot: number): string | null {
  const other = voiceSlot !== null && voiceSlot !== slot ? voiceSlot : registry().order.find((s) => s !== slot && summaryOf(s).inVoice) ?? null
  voiceSlot = slot
  bridges?.ownerChanged()
  if (other === null) return null
  const name = views().find((v) => v.slot === slot)?.name ?? ''
  for (const listener of [...(frames.get(other)?.leaveVoice ?? [])]) listener(name)
  return views().find((v) => v.slot === other)?.name || null
}

function reported(slot: number, patch: Partial<AccountSummary>): void {
  const before = summaryOf(slot)
  const summary = { ...before, ...patch }
  // Every page gets the list: a copy of the picture's bytes, never a reference into the reporting page.
  if (patch.avatar && patch.avatar.hash !== before.avatar?.hash) summary.avatar = { ...patch.avatar, bytes: patch.avatar.bytes.slice(0) }
  else if (patch.avatar) summary.avatar = before.avatar
  useHost.setState((s) => ({ summaries: { ...s.summaries, [slot]: summary } }))
  if (summary.inVoice && voiceSlot !== slot) {
    voiceSlot = slot
    bridges?.ownerChanged()
  } else if (!summary.inVoice && voiceSlot === slot) {
    voiceSlot = null
    bridges?.ownerChanged()
  }
  // Signed in: remember its name and key for the switcher, and it's no longer being added. An account that's already
  // signed in here in another slot stays "being added": its page offers to go to the first one (and signs out).
  const reg = registry()
  const entry = reg.accounts[slot]
  const first = summary.ready && summary.key && entry?.adding ? otherWithKey(summary.key, slot) : null
  if (first !== null) {
    duplicates.set(slot, first)
    broadcast()
  } else if (entry && summary.ready && !duplicates.has(slot)
    && (entry.adding || (summary.name && entry.name !== summary.name) || (summary.key && entry.key !== summary.key))) {
    returnTo.delete(slot)
    save(updateEntry(reg, slot, { adding: undefined, name: summary.name || entry.name, key: summary.key ?? entry.key }))
  } else {
    broadcast()
  }
  guardHistory()
}

/** Another account slot signed in to the account `key`. */
function otherWithKey(key: string, slot: number): number | null {
  const reg = registry()
  return reg.order.find((s) => s !== slot && !duplicates.has(s) && (summaryOf(s).key ?? reg.accounts[s]?.key) === key) ?? null
}

// ── Links from outside ──────────────────────────────────────────────────

/** An app route the host was opened with or given ("#/join/…", "#/link/…", "#/open/…"); `account`: who it's for, if known. */
export function incoming(link: IncomingLink, account?: number | null): void {
  const reg = registry()
  if (link.kind === 'hash' && link.route.startsWith('#/link/')) {
    // A device link would put someone's account on this device: never without the person saying so first (whatever
    // account the link names), and the account's page then waits for them to press "Link this device" too.
    useHost.setState({ linking: link.route })
    return
  }
  if (account && reg.order.includes(account)) return deliver(account, link)
  const ready = reg.order.filter((s) => !reg.accounts[s]?.adding)
  if (ready.length <= 1) return deliver(ready[0] ?? reg.active, link)
  useHost.setState({ choosing: link })
}

/** The answer to "Link this device to another account?": yes goes to an account being added (or a new one). */
export function confirmLinking(yes: boolean): void {
  const route = useHost.getState().linking
  useHost.setState({ linking: null })
  if (!route || !yes) return
  const reg = registry()
  const slot = reg.order.find((s) => reg.accounts[s]?.adding && !summaryOf(s).ready) ?? addAccountSlot('link')
  if (slot !== null) deliver(slot, { kind: 'hash', route })
}

/** Room for one more account here. */
export const roomForAccount = (): boolean => registry().order.length < hostMax

export function choose(slot: number | null): void {
  const link = useHost.getState().choosing
  useHost.setState({ choosing: null })
  if (link && slot !== null) deliver(slot, link)
}

function deliver(slot: number, link: IncomingLink): void {
  switchTo(slot)
  if (link.kind !== 'hash') return bridges?.deliverLink(slot, link)
  const f = frame(slot)
  if (!f.link || !f.win) {
    f.pendingRoute = link.route
    return
  }
  handTo(f.win, link.route)
}

/** Puts a route in a frame's address (without a history entry), where its page picks it up like any opened link. */
function handTo(win: Window, route: string): void {
  try {
    win.location.replace(win.location.pathname + win.location.search + route)
  } catch {
    /* gone meanwhile */
  }
}

// ── Back (web): the host keeps the one history entry; the account on screen decides what back does ──

const GUARD = 'iskraHost'
let guarded = false
function guardHistory(): void {
  // Browsers skip entries added before the person touched the page (a touch in a frame counts for the host too).
  if (guarded || shellNative || !(navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) return
  guarded = true
  if ((history.state as Record<string, unknown> | null)?.[GUARD] !== true) history.pushState({ [GUARD]: true }, '')
}

let leavingUntil = 0
function onPopState(): void {
  if (Date.now() < leavingUntil) return void history.back()
  if (/^#\/(open|join|link)\//.test(location.hash)) return
  const back = frames.get(registry().active)?.back
  if (!back || back() === 'exit') {
    leavingUntil = Date.now() + 1000
    history.back()
    return
  }
  history.pushState({ [GUARD]: true }, '')
}

// ── Safe areas: frames don't get the notch's insets from the system, so they get the host's ──

let probe: HTMLElement | null = null
function insets(): Record<string, string> {
  if (!probe) {
    probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;'
      + 'padding:var(--safe-area-inset-top,env(safe-area-inset-top,0px)) var(--safe-area-inset-right,env(safe-area-inset-right,0px)) '
      + 'var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)) var(--safe-area-inset-left,env(safe-area-inset-left,0px))'
    document.body.appendChild(probe)
  }
  const style = getComputedStyle(probe)
  return { top: style.paddingTop, right: style.paddingRight, bottom: style.paddingBottom, left: style.paddingLeft }
}

function shareInsets(): void {
  const values = insets()
  for (const f of frames.values()) {
    try {
      const root = f.element?.contentDocument?.documentElement
      if (!root) continue
      for (const [side, value] of Object.entries(values)) root.style.setProperty(`--safe-area-inset-${side}`, value)
    } catch {
      /* not loaded */
    }
  }
}

// ── The frames' side ────────────────────────────────────────────────────

/** The React host shows a frame for each account and tells us its element (null when it goes). */
export function registerFrame(slot: number, element: HTMLIFrameElement | null): void {
  const f = frame(slot)
  if (element) f.element = element
  else if (f.element && !f.element.isConnected) f.element = null
}

function makeLink(slot: number, win: Window): AccountLink {
  const f = frame(slot)
  // A fresh page in this frame (it reloaded): what the old one listened to goes.
  f.listeners.clear()
  f.leaveVoice.clear()
  f.input.clear()
  f.back = null
  bridges?.drop(slot, true)
  f.win = win
  const link: AccountLink = {
    slot,
    max: hostMax,
    desktop: bridges?.desktopFor(slot),
    native: bridges?.nativeFor(slot),
    adding: () => registry().accounts[slot]?.adding ?? null,
    accounts: views,
    onAccounts(listener) {
      f.listeners.add(listener)
      return () => f.listeners.delete(listener)
    },
    report: (summary) => reported(slot, summary),
    switchTo,
    activate: () => switchTo(slot),
    add(mode) {
      addAccountSlot(mode)
    },
    cancelAdd() {
      if (!registry().accounts[slot]?.adding) return
      void removeSlot(slot, returnTo.get(slot))
    },
    signedOut: () => void removeSlot(slot),
    move: (which, delta) => save(moveAccount(registry(), which, delta)),
    claimVoice: () => claimVoice(slot),
    onLeaveVoice(listener) {
      f.leaveVoice.add(listener)
      return () => f.leaveVoice.delete(listener)
    },
    setBack(handler) {
      f.back = handler
    },
    input() {
      for (const [other, state] of frames) {
        if (other === slot) continue
        for (const listener of [...state.input]) listener()
      }
    },
    onInput(listener) {
      f.input.add(listener)
      return () => f.input.delete(listener)
    },
  }
  f.link = link
  // Once its page is up: the safe areas, and a route that came in while it was loading.
  setTimeout(() => {
    shareInsets()
    const route = f.pendingRoute
    f.pendingRoute = null
    if (route) handTo(win, route)
  }, 0)
  return link
}

const api: HostApi = {
  version: 1,
  link(slot, win) {
    // Only the frame the host made for this account gets its link.
    const element = frames.get(slot)?.element
    if (!element || element.contentWindow !== win || !registry().order.includes(slot)) return null
    return makeLink(slot, win)
  },
}

/** Starts the host: the list, its window hooks and the shells. Returns the route the page was opened with, if any. */
export function startHost(): void {
  const reg = parseRegistry(rawLocalStorage?.getItem(REGISTRY_KEY) ?? null)
  // Opened for an account (a notification of one that was closed: "?account=2#/open/…"), and with a link.
  const params = new URLSearchParams(location.search)
  const wanted = Number(params.get('account'))
  const route = /^#\/(open|join|link)\//.test(location.hash) ? location.hash : null
  if (location.search || location.hash) history.replaceState(null, '', location.pathname)
  useHost.setState({ registry: wanted && reg.order.includes(wanted) ? setActive(reg, wanted) : reg })
  Object.defineProperty(window, '__iskraHost', { value: api, configurable: false, writable: false })

  bridges = createBridges({ desktop: shellDesktop, native: shellNative }, {
    active: () => registry().active,
    voice: () => voiceSlot,
    slots: () => registry().order,
  }, (link) => {
    if (link.kind === 'url') {
      // A phone link: device links and invites both end up in an account's page through its own handler.
      incoming(link.value.includes('#/link/') ? { kind: 'hash', route: link.value.slice(link.value.indexOf('#/link/')) } : link)
      return
    }
    incoming(link)
  })

  window.addEventListener('hashchange', () => {
    const hash = location.hash
    if (!/^#\/(open|join|link)\//.test(hash)) return
    history.replaceState(history.state, '', location.pathname)
    incoming({ kind: 'hash', route: hash })
  })
  // A push notification's click, from the push service worker (public/push-sw.js names the account).
  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; route?: unknown; account?: unknown } | null
    if (data?.type !== 'iskra.open' || typeof data.route !== 'string' || !data.route.startsWith('/open/')) return
    incoming({ kind: 'hash', route: `#${data.route}` }, typeof data.account === 'number' ? data.account : null)
  })
  window.addEventListener('popstate', onPopState)
  window.addEventListener('resize', shareInsets)
  showTotals()
  if (route) incoming({ kind: 'hash', route }, wanted || null)
}

/** For tests: forget everything. */
export function resetHostForTests(): void {
  frames.clear()
  returnTo.clear()
  duplicates.clear()
  voiceSlot = null
  bridges = null
  useHost.setState({ registry: parseRegistry(null), summaries: {}, choosing: null, linking: null })
}

export const hostApiForTests = api
