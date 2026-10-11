// Local persistence in IndexedDB: the identity keys, the list of servers, prekeys and DM history.
// Keys only leave this device inside an end-to-end encrypted device link (see core/link.ts).
// Secrets (keys, prekeys, decrypted DMs) are encrypted at rest with the vault's data key (core/vault.ts).
import { b64u, fromB64u } from './crypto'
import type { PrekeyPair, Revocation } from './devices'
import type { DeviceCert, Identity } from './identity'
import type { Handover, Rotation } from './rotation'
import {
  browserWrapper, isSealed, lockDataKey, newDataKey, openValue, sealValue, unlockDataKey,
  type KeyWrapper, type VaultRecord, type WrapKind,
} from './vault'

const DB_NAME = 'iskra'
const STORE = 'kv'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

async function remove(key: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function set(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Encryption at rest ─────────────────────────────────────────────────────

let dataKey: Uint8Array | null = null
let vault: VaultRecord | null = null
let wrapper: KeyWrapper | null = null
/** The unwrapped passphrase box, while the app lock waits for its passphrase. */
let lockedBox: Uint8Array | null = null

export type VaultState =
  | { state: 'open' }
  | { state: 'locked' }
  | { state: 'error'; message: string }

const browserWrap = browserWrapper(() => get<CryptoKey>('vault-wrap-key'), (key) => set('vault-wrap-key', key))

/** Slots holding secrets. Anything else (server list, friends, profile) stays readable before unlock. */
const SECRET_SLOTS = ['identity', 'prekeys', 'dm-peers']

async function getSecret<T>(slot: string): Promise<T | undefined> {
  const raw = await get<unknown>(slot)
  if (raw === undefined) return undefined
  if (!isSealed(raw)) return raw as T // stored before encryption at rest; migrated on open
  if (!dataKey) throw new Error('Iskra is locked.')
  return openValue<T>(dataKey, slot, raw)
}

async function setSecret(slot: string, value: unknown): Promise<void> {
  if (!dataKey) throw new Error('Iskra is locked.')
  await set(slot, sealValue(dataKey, slot, value))
}

/** Encrypts anything still stored in the clear (data from before encryption at rest). Safe to repeat. */
async function migrateSecrets(): Promise<void> {
  if (await get('vault-migrated')) return
  const peers = (await getSecret<string[]>('dm-peers')) ?? []
  const groups = (await getSecret<string[]>('group-keys')) ?? []
  for (const slot of [...SECRET_SLOTS, 'group-keys', ...peers.map((p) => `dm:${p}`), ...groups.map((g) => `group:${g}`)]) {
    const raw = await get<unknown>(slot)
    if (raw !== undefined && !isSealed(raw)) await setSecret(slot, raw)
  }
  await set('vault-migrated', 1)
}

/**
 * Opens (or on first start creates) the vault. <paramref name="system"/> is the OS keychain wrap when the desktop app
 * has one; otherwise the browser wrap is used. Resolves 'locked' when an app lock passphrase is set.
 */
export async function openVault(system?: KeyWrapper | null): Promise<VaultState> {
  if (dataKey) return { state: 'open' }
  vault = (await get<VaultRecord>('vault')) ?? null
  if (!vault) {
    wrapper = system ?? browserWrap
    const key = newDataKey()
    vault = { v: 1, wrap: wrapper.kind, data: b64u(await wrapper.wrap(key)) }
    await set('vault', vault)
    dataKey = key
    await migrateSecrets()
    return { state: 'open' }
  }
  if (vault.wrap === 'system' && !system)
    return { state: 'error', message: "Iskra's keys are protected by this computer's keychain, which isn't available right now." }
  wrapper = vault.wrap === 'system' ? system! : browserWrap
  let inner: Uint8Array
  try {
    inner = await wrapper.unwrap(fromB64u(vault.data))
  } catch {
    return {
      state: 'error',
      message: vault.wrap === 'system'
        ? "This computer's keychain wouldn't unlock Iskra's keys. Make sure you're signed in as the same user, then try again."
        : "The key that protects Iskra's data in this browser is missing or damaged.",
    }
  }
  // The keychain became available (e.g. Linux with a keyring now): move to it.
  if (vault.wrap === 'browser' && system) {
    vault = { ...vault, wrap: 'system', data: b64u(await system.wrap(inner)) }
    wrapper = system
    await set('vault', vault)
  }
  if (vault.lock) {
    lockedBox = inner
    return { state: 'locked' }
  }
  dataKey = inner
  await migrateSecrets()
  return { state: 'open' }
}

/** Tries the app lock passphrase. False if it's wrong. */
export async function unlockVault(passphrase: string): Promise<boolean> {
  if (!vault?.lock || !lockedBox) return !!dataKey
  const key = unlockDataKey(lockedBox, passphrase, vault.lock)
  if (!key) return false
  dataKey = key
  lockedBox = null
  await migrateSecrets()
  return true
}

/** Sets, changes or (null) removes the app lock passphrase. */
export async function setLockPassphrase(passphrase: string | null): Promise<void> {
  if (!dataKey || !wrapper || !vault) throw new Error('Iskra is locked.')
  if (passphrase) {
    const { box, params } = lockDataKey(dataKey, passphrase)
    vault = { v: 1, wrap: wrapper.kind, data: b64u(await wrapper.wrap(box)), lock: params }
  } else {
    vault = { v: 1, wrap: wrapper.kind, data: b64u(await wrapper.wrap(dataKey)) }
  }
  await set('vault', vault)
}

/** Checks the current app lock passphrase (asked before changing or removing it). */
export async function checkLockPassphrase(passphrase: string): Promise<boolean> {
  if (!vault?.lock || !wrapper) return false
  try {
    const box = await wrapper.unwrap(fromB64u(vault.data))
    return unlockDataKey(box, passphrase, vault.lock) !== null
  } catch {
    return false
  }
}

export const vaultInfo = (): { wrap: WrapKind | null; locked: boolean } => ({ wrap: vault?.wrap ?? null, locked: !!vault?.lock })

interface StoredIdentity {
  v: 1
  accountPublic: string
  accountSecret: string
  devicePublic: string
  deviceSecret: string
  cert: DeviceCert
}

export interface Profile {
  name: string
  /** The user copied or downloaded their recovery key. */
  recoverySaved?: boolean
  // Profile details sent to every server. Undefined: never set on this device, so servers keep what they have.
  bio?: string
  pronouns?: string
  accent?: string
  /** null: removed on purpose. */
  avatar?: { bytes: ArrayBuffer; type: string; hash: string } | null
  page?: { html: string; hash: string } | null
}

export interface SavedServer {
  url: string
  serverKey: string
  name: string
  /** Kept until the first successful join, then cleared. */
  invite?: string
}

export async function loadIdentity(): Promise<Identity | null> {
  const stored = await getSecret<StoredIdentity>('identity')
  if (!stored || stored.v !== 1) return null
  return {
    account: { publicKey: fromB64u(stored.accountPublic), secretKey: fromB64u(stored.accountSecret) },
    device: { publicKey: fromB64u(stored.devicePublic), secretKey: fromB64u(stored.deviceSecret) },
    cert: stored.cert,
  }
}

export async function saveIdentity(identity: Identity): Promise<void> {
  const stored: StoredIdentity = {
    v: 1,
    accountPublic: b64u(identity.account.publicKey),
    accountSecret: b64u(identity.account.secretKey),
    devicePublic: b64u(identity.device.publicKey),
    deviceSecret: b64u(identity.device.secretKey),
    cert: identity.cert,
  }
  await setSecret('identity', stored)
}

export const loadProfile = () => get<Profile>('profile')
export const saveProfile = (profile: Profile) => set('profile', profile)

export async function loadServers(): Promise<SavedServer[]> {
  return (await get<SavedServer[]>('servers')) ?? []
}

export const saveServers = (servers: SavedServer[]) => set('servers', servers)

export interface StoredFriend {
  accountKey: string
  name: string
  addedAt: number
}

export async function loadFriends(): Promise<StoredFriend[]> {
  return (await get<StoredFriend[]>('friends')) ?? []
}

export const saveFriends = (friends: StoredFriend[]) => set('friends', friends)

/** Friend requests and friends (state/friends.ts): per person, the signed actions both sides sent. */
export interface StoredFriendState {
  v: 1
  peers: Record<string, { name: string; events: { id: string; kind: import('./friend').FriendKind; mine: boolean; at: number }[] }>
  /** People to send a request to once we share a server (friends from before requests existed). */
  unsent: string[]
}

export const loadFriendState = () => get<StoredFriendState>('friendState')
export const saveFriendState = (state: StoredFriendState) => set('friendState', state)

/** Ask the browser not to evict our data (matters most on iOS Safari). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

// ── Devices: prekeys, revocations, decrypted DM history ─────────────────────

interface StoredPrekey {
  publicKey: string
  secretKey: string
  created: number
  retiredAt?: number
}

export async function loadPrekeys(): Promise<PrekeyPair[]> {
  const stored = (await getSecret<StoredPrekey[]>('prekeys')) ?? []
  return stored.map((p) => ({ publicKey: fromB64u(p.publicKey), secretKey: fromB64u(p.secretKey), created: p.created, retiredAt: p.retiredAt }))
}

export const savePrekeys = (prekeys: PrekeyPair[]) =>
  setSecret('prekeys', prekeys.map((p): StoredPrekey => ({ publicKey: b64u(p.publicKey), secretKey: b64u(p.secretKey), created: p.created, retiredAt: p.retiredAt })))

/** Revocations this account made (from any of its devices), re-sent to servers that missed them. */
export async function loadRevocations(): Promise<Revocation[]> {
  return (await get<Revocation[]>('revocations')) ?? []
}

export const saveRevocations = (revocations: Revocation[]) => set('revocations', revocations)

/** A decrypted direct message as kept on this device. */
export interface StoredDm {
  id: string
  from: string
  to: string
  text: string
  sentAt: number
  /** Call log entries (see state/calls.ts). */
  call?: Record<string, unknown>
  /** A local notice ("safety number changed"), see state/dms.ts. */
  notice?: 'key-changed' | 'key-disputed'
  forward?: import('./dm').DmForward
  /** Encrypted attachments: where they are and their keys (core/dmFiles.ts). */
  files?: unknown
  /** A checked friend action (core/friend.ts). */
  friend?: import('./friend').FriendAction
}

/** Decrypted DMs per conversation. Servers keep only envelopes, and old prekeys get deleted, so this is the history. */
export async function loadDmHistory(): Promise<Record<string, StoredDm[]>> {
  const peers = (await getSecret<string[]>('dm-peers')) ?? []
  const entries = await Promise.all(peers.map(async (peer) => [peer, (await getSecret<StoredDm[]>(`dm:${peer}`)) ?? []] as const))
  return Object.fromEntries(entries)
}

export async function saveDmConversation(peer: string, messages: StoredDm[]): Promise<void> {
  const peers = (await getSecret<string[]>('dm-peers')) ?? []
  if (!peers.includes(peer)) await setSecret('dm-peers', [...peers, peer])
  await setSecret(`dm:${peer}`, messages)
}

// ── group DMs ──

/** A group DM as kept on this device: its verified chain (re-checked on load), name and decrypted messages. */
export interface StoredGroup {
  serverKey: string
  id: string
  chain: { payload: string; sig: string }[]
  name: string | null
  nameAt: number
  /** Display names of the people in it, so an archived group (server gone) still shows who said what. */
  names?: Record<string, string>
  messages: (StoredDm & { group?: Record<string, unknown> })[]
}

// Group messages are decrypted content, so they're encrypted at rest like DMs.
export async function loadGroups(): Promise<StoredGroup[]> {
  const keys = (await getSecret<string[]>('group-keys')) ?? []
  const groups = await Promise.all(keys.map((key) => getSecret<StoredGroup>(`group:${key}`)))
  return groups.filter((g): g is StoredGroup => !!g)
}

export async function saveGroup(key: string, group: StoredGroup): Promise<void> {
  const keys = (await getSecret<string[]>('group-keys')) ?? []
  if (!keys.includes(key)) await setSecret('group-keys', [...keys, key])
  await setSecret(`group:${key}`, group)
}

export async function deleteGroup(key: string): Promise<void> {
  const keys = (await getSecret<string[]>('group-keys')) ?? []
  await setSecret('group-keys', keys.filter((k) => k !== key))
  await remove(`group:${key}`)
}

/** Drops a conversation (after merging it into another one, e.g. the peer's key rotated). */
export async function deleteDmConversation(peer: string): Promise<void> {
  const peers = (await getSecret<string[]>('dm-peers')) ?? []
  if (peers.includes(peer)) await setSecret('dm-peers', peers.filter((p) => p !== peer))
  await remove(`dm:${peer}`)
}

// ── Account key rotations (public, signed statements) ──────────────────────

/** Verified rotations this device knows: its own account's and its contacts'. */
export async function loadRotations(): Promise<Rotation[]> {
  return (await get<Rotation[]>('rotations')) ?? []
}

export const saveRotations = (rotations: Rotation[]) => set('rotations', rotations)

/** A rotation this device made, with what each server still needs (certificates and hand-overs). */
export interface RotationOutbox {
  rotation: Rotation
  certs: DeviceCert[]
  handovers: Handover[]
  /** Servers that have the whole package. */
  done: string[]
}

export const loadRotationOutbox = async () => (await get<RotationOutbox[]>('rotation-outbox')) ?? []
export const saveRotationOutbox = (outbox: RotationOutbox[]) => set('rotation-outbox', outbox)

/** Forgets everything on this device (after it was removed from its account). */
export function wipeAll(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve()
  })
}

// ── Block list (synced to every server; see state/moderation.ts) ────────────

export async function loadBlocks(): Promise<import('./protocol').BlockEntry[]> {
  return (await get<import('./protocol').BlockEntry[]>('blocks')) ?? []
}

export const saveBlocks = (blocks: import('./protocol').BlockEntry[]) => set('blocks', blocks)
