// Runs first, before any other module (main.tsx imports it first): decides which account this page is for and keeps
// its storage apart from every other account's (platform/accountSlots.ts).
//
// - solo: one account on the device (every install before several accounts, and most still). Nothing changes.
// - host: the top page while several accounts are signed in. It holds one frame per account (state/accountHost.ts) and
//   keeps no account data of its own.
// - frame: one account's page inside the host. Its localStorage and sessionStorage only see its own keys, and its
//   databases are its own (core/accountSlot.ts).
import { setAccountSlot } from '../core/accountSlot'
import type { AccountLink, HostApi } from './accountLink'
import { hostStorage, namespacedStorage, parseRegistry, REGISTRY_KEY, type Registry } from './accountSlots'

/** `refused`: a frame asking to be an account (`?account=`) that the host page doesn't vouch for: it runs nothing. */
export type BootMode = 'solo' | 'frame' | 'host' | 'refused'

function read(name: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window[name]
  } catch {
    return null // storage blocked
  }
}

/** The real storages, before this account's view replaces them (the list of accounts lives here). */
export const rawLocalStorage = read('localStorage')
export const rawSessionStorage = read('sessionStorage')

function loadRegistry(): Registry {
  try {
    return parseRegistry(rawLocalStorage?.getItem(REGISTRY_KEY) ?? null)
  } catch {
    return parseRegistry(null)
  }
}

/** Inside the host's frame for an account: the link the host made for it. */
function frameLink(): AccountLink | null {
  if (typeof window === 'undefined' || window.parent === window) return null
  const slot = Number(new URLSearchParams(window.location.search).get('account'))
  if (!Number.isSafeInteger(slot) || slot < 1) return null
  try {
    // Only a same-origin parent can be read; any other throws.
    const host = (window.parent as unknown as { __iskraHost?: HostApi }).__iskraHost
    return host?.version === 1 ? host.link(slot, window) : null
  } catch {
    return null
  }
}

/** False if the page's storage couldn't be replaced by this account's view: such a frame must not run (main.tsx). */
export let storageIsolated = true

function install(name: 'localStorage' | 'sessionStorage', raw: Storage | null, slot: number): void {
  if (!raw) return
  const view = slot === 0 ? hostStorage(raw) : namespacedStorage(raw, slot)
  try {
    Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => view })
  } catch {
    /* checked below */
  }
  if (window[name] !== view) storageIsolated = false
}

export const accountLink: AccountLink | null = frameLink()
const registry = loadRegistry()
const topLevel = typeof window !== 'undefined' && window.parent === window

/** A frame that names an account but got no link for it must never run as some account (a hidden second copy). */
const unvouched = !accountLink && !topLevel && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('account')

export const bootMode: BootMode = accountLink ? 'frame' : unvouched ? 'refused' : topLevel && registry.order.length > 1 ? 'host' : 'solo'

/** This page's account slot (0 for the host or a refused frame, which have none). */
export const bootSlot: number = accountLink ? accountLink.slot : bootMode === 'host' || bootMode === 'refused' ? 0 : registry.active

if (bootMode === 'solo' || bootMode === 'frame') {
  setAccountSlot(bootSlot)
  // Account 1 on its own uses storage exactly as before; any other slot, or account 1 next to others, gets its view.
  if (bootMode === 'frame' || bootSlot !== 1) {
    install('localStorage', rawLocalStorage, bootSlot)
    install('sessionStorage', rawSessionStorage, bootSlot)
  }
} else {
  // The host page (or a refused frame) has no account: the app's modules (loaded, never started) keep nothing real.
  install('localStorage', rawLocalStorage, 0)
  install('sessionStorage', rawSessionStorage, 0)
}
