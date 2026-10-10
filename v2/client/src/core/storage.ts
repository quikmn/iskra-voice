// Local persistence in IndexedDB: the identity keys and the list of servers.
// Keys never leave this device (device linking and recovery come later, see the design doc).
import { b64u, fromB64u } from './crypto'
import type { DeviceCert, Identity } from './identity'

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

async function set(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

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
}

export interface SavedServer {
  url: string
  serverKey: string
  name: string
  /** Kept until the first successful join, then cleared. */
  invite?: string
}

export async function loadIdentity(): Promise<Identity | null> {
  const stored = await get<StoredIdentity>('identity')
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
  await set('identity', stored)
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

/** Ask the browser not to evict our data (matters most on iOS Safari). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
