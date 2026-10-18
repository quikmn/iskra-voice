// Several accounts on one device: the list of accounts ("slots") and how each one's storage is kept apart.
//
// Each signed-in account has a slot number. Its IndexedDB databases get "@<n>" on their names (core/accountSlot.ts) and
// its localStorage and sessionStorage keys get "iskra@<n>:" in front (NamespacedStorage below, installed for the whole
// page by accountBoot.ts, so no code can reach another account's keys by accident). Slot 1 keeps the plain names from
// before there were several accounts: an existing install is account 1 with nothing moved.
//
// The list itself is device data, kept under REGISTRY_KEY: slot numbers, the order, which one is open, and each
// account's display name and public key (for the switcher before its page has loaded). Never anything secret.
import { slotDbName } from '../core/accountSlot'

export const REGISTRY_KEY = 'iskra-accounts'
/** Each signed-in account keeps its own connections open: this many at most on one device. */
export const MAX_ACCOUNTS = 5
/** Phones keep fewer (memory and battery). */
export const MAX_ACCOUNTS_PHONE = 3

/** Settings of the device itself, shared by every account on it: the language and the theme. */
export const DEVICE_KEYS: readonly string[] = ['iskra.language', 'iskra.theme']

/** Settings a new account starts with, copied from the account that added it (sound devices, keys, the terms). */
export const SEED_KEYS: readonly string[] = ['iskra.audio', 'iskra.audio.aiSlow', 'iskra.voice', 'iskra.hotkeys', 'iskra.terms']

/** How a new account was being added, until it's signed in: made new, or an account from another device. */
export type AddMode = 'new' | 'link'

export interface AccountEntry {
  slot: number
  /** The display name it had last time (for the switcher before its page is up). */
  name?: string
  /** Its account public key (b64u), to notice the same account added twice. */
  key?: string
  /** Being added and not signed in yet. */
  adding?: AddMode
}

export interface Registry {
  v: 1
  /** The account on screen. */
  active: number
  /** The switcher's order. */
  order: number[]
  accounts: Record<number, AccountEntry>
}

const validSlot = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 99

/** A device that never had several accounts: account 1 alone. */
export const singleRegistry = (slot = 1): Registry => ({ v: 1, active: slot, order: [slot], accounts: { [slot]: { slot } } })

/** The stored list, checked; anything odd falls back to account 1 alone (what every install was before). */
export function parseRegistry(raw: string | null): Registry {
  if (!raw) return singleRegistry()
  try {
    const data = JSON.parse(raw) as Partial<Registry> | null
    if (!data || data.v !== 1 || !Array.isArray(data.order)) return singleRegistry()
    const order = [...new Set(data.order.filter(validSlot))]
    if (!order.length) return singleRegistry()
    const accounts: Record<number, AccountEntry> = {}
    for (const slot of order) {
      const entry = (data.accounts as Record<string, unknown> | undefined)?.[slot] as Partial<AccountEntry> | undefined
      accounts[slot] = {
        slot,
        ...(typeof entry?.name === 'string' ? { name: entry.name.slice(0, 64) } : {}),
        ...(typeof entry?.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(entry.key) ? { key: entry.key } : {}),
        ...(entry?.adding === 'new' || entry?.adding === 'link' ? { adding: entry.adding } : {}),
      }
    }
    const active = validSlot(data.active) && order.includes(data.active) ? data.active : order[0]
    return { v: 1, active, order, accounts }
  } catch {
    return singleRegistry()
  }
}

export const serializeRegistry = (registry: Registry): string => JSON.stringify(registry)

/** The lowest free slot number. */
export function freeSlot(registry: Registry): number {
  let n = 1
  while (registry.order.includes(n)) n++
  return n
}

/** Adds an account being set up and opens it. Null when the device already has `max`. */
export function addAccount(registry: Registry, mode: AddMode, max = MAX_ACCOUNTS): { registry: Registry; slot: number } | null {
  if (registry.order.length >= max) return null
  const slot = freeSlot(registry)
  return {
    slot,
    registry: { ...registry, active: slot, order: [...registry.order, slot], accounts: { ...registry.accounts, [slot]: { slot, adding: mode } } },
  }
}

/** Takes an account off the list; the one on screen moves to `fallback` (or the first left) if it was this one. */
export function removeAccount(registry: Registry, slot: number, fallback?: number): Registry {
  const order = registry.order.filter((s) => s !== slot)
  const accounts = { ...registry.accounts }
  delete accounts[slot]
  const active = registry.active !== slot ? registry.active : fallback !== undefined && order.includes(fallback) ? fallback : order[0] ?? 1
  return { ...registry, order, accounts, active }
}

export function setActive(registry: Registry, slot: number): Registry {
  return registry.order.includes(slot) ? { ...registry, active: slot } : registry
}

/** Moves an account up (-1) or down (+1) in the switcher. */
export function moveAccount(registry: Registry, slot: number, delta: -1 | 1): Registry {
  const i = registry.order.indexOf(slot)
  const j = i + delta
  if (i < 0 || j < 0 || j >= registry.order.length) return registry
  const order = [...registry.order]
  ;[order[i], order[j]] = [order[j], order[i]]
  return { ...registry, order }
}

export function updateEntry(registry: Registry, slot: number, patch: Partial<Omit<AccountEntry, 'slot'>>): Registry {
  const entry = registry.accounts[slot]
  if (!entry) return registry
  const next: AccountEntry = { ...entry, ...patch, slot }
  for (const k of ['name', 'key', 'adding'] as const) if (next[k] === undefined) delete next[k]
  return { ...registry, accounts: { ...registry.accounts, [slot]: next } }
}

/** The other slot already signed in to this account, if any. */
export const slotWithKey = (registry: Registry, key: string, except: number): number | null =>
  registry.order.find((s) => s !== except && registry.accounts[s]?.key === key) ?? null

// ── Keeping each account's Web Storage apart ──────────────────────────────

const NS = /^iskra@\d+:/

/** The key prefix of a slot's localStorage and sessionStorage keys ('' for account 1). */
export const keyPrefix = (slot: number): string => (slot === 1 ? '' : `iskra@${slot}:`)

/** The stored name of `key` for `slot`: device keys and the list of accounts are shared, the rest is the slot's own. */
export function storedKey(slot: number, key: string): string | null {
  if (key === REGISTRY_KEY) return null
  if (DEVICE_KEYS.includes(key)) return key
  if (slot === 1) return NS.test(key) ? null : key
  return keyPrefix(slot) + key
}

/** The slot's own keys (as its code names them) among the stored ones; device keys aren't counted as its own. */
export function ownKeys(slot: number, stored: readonly string[]): string[] {
  const prefix = keyPrefix(slot)
  if (slot === 1) return stored.filter((k) => !NS.test(k) && k !== REGISTRY_KEY && !DEVICE_KEYS.includes(k))
  return stored.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
}

const rawKeys = (raw: Storage): string[] => {
  const keys: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const k = raw.key(i)
    if (k !== null) keys.push(k)
  }
  return keys
}

/**
 * A Storage that only sees one account's keys. It also answers Object.keys() and property reads the way the real
 * one does (signOut.ts lists keys that way), and hides the list of accounts and other accounts' keys entirely.
 */
export function namespacedStorage(raw: Storage, slot: number): Storage {
  const own = () => ownKeys(slot, rawKeys(raw))
  const api: Storage = {
    get length() {
      return own().length
    },
    key: (index: number) => own()[index] ?? null,
    getItem(key: string) {
      const name = storedKey(slot, String(key))
      return name === null ? null : raw.getItem(name)
    },
    setItem(key: string, value: string) {
      const name = storedKey(slot, String(key))
      if (name !== null) raw.setItem(name, String(value))
    },
    removeItem(key: string) {
      const name = storedKey(slot, String(key))
      if (name !== null) raw.removeItem(name)
    },
    clear() {
      for (const key of own()) raw.removeItem(keyPrefix(slot) + key)
    },
  }
  const methods = new Set<PropertyKey>(['length', 'key', 'getItem', 'setItem', 'removeItem', 'clear'])
  return new Proxy(api, {
    get(target, prop) {
      if (methods.has(prop) || typeof prop !== 'string') return Reflect.get(target, prop)
      return target.getItem(prop) ?? undefined
    },
    set(target, prop, value) {
      if (typeof prop !== 'string' || methods.has(prop)) return false
      target.setItem(prop, String(value))
      return true
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'string' && !methods.has(prop)) target.removeItem(prop)
      return true
    },
    has(target, prop) {
      return methods.has(prop) || (typeof prop === 'string' && target.getItem(prop) !== null)
    },
    ownKeys: () => own(),
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop !== 'string' || methods.has(prop)) return undefined
      const value = target.getItem(prop)
      return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true }
    },
  })
}

/**
 * The host page's storage: it has no account, so anything the app's (idle) modules there keep stays in memory and goes
 * with the page. Only the device settings (language, theme) are the real ones.
 */
export function hostStorage(raw: Storage): Storage {
  const kept = new Map<string, string>()
  const api: Storage = {
    get length() {
      return kept.size
    },
    key: (index: number) => [...kept.keys()][index] ?? null,
    getItem: (key: string) => (DEVICE_KEYS.includes(key) ? raw.getItem(key) : kept.get(String(key)) ?? null),
    setItem(key: string, value: string) {
      if (DEVICE_KEYS.includes(key)) raw.setItem(key, String(value))
      else kept.set(String(key), String(value))
    },
    removeItem(key: string) {
      if (DEVICE_KEYS.includes(key)) raw.removeItem(key)
      else kept.delete(String(key))
    },
    clear: () => kept.clear(),
  }
  return api
}

/** Copies the settings a new account starts with from one slot to another (only ones the new slot doesn't have). */
export function seedSettings(raw: Storage, from: number, to: number): void {
  for (const key of SEED_KEYS) {
    const source = storedKey(from, key)
    const target = storedKey(to, key)
    if (!source || !target || raw.getItem(target) !== null) continue
    const value = raw.getItem(source)
    if (value !== null) raw.setItem(target, value)
  }
}

/** The IndexedDB databases an account keeps (core/storage.ts, the transcript cache). */
export const ACCOUNT_DATABASES: readonly string[] = ['iskra', 'iskra-transcripts']

/**
 * Forgets everything a slot stored on this device, without its page (an account given up on while being added).
 * Accounts that are signed in sign out through their own page instead, which also tells their servers.
 */
export async function wipeSlot(slot: number, stores: { local?: Storage | null; session?: Storage | null; idb?: IDBFactory | null }): Promise<void> {
  for (const raw of [stores.local, stores.session]) {
    if (!raw) continue
    try {
      for (const key of ownKeys(slot, rawKeys(raw))) raw.removeItem(keyPrefix(slot) + key)
    } catch {
      /* storage blocked */
    }
  }
  const idb = stores.idb
  if (!idb) return
  await Promise.all(ACCOUNT_DATABASES.map((base) => new Promise<void>((resolve) => {
    try {
      const request = idb.deleteDatabase(slotDbName(base, slot))
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })))
}
